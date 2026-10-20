package cache

import (
	"container/list"
	"context"
	"sync"
	"time"
)

// Memory is an in-process LRU cache bounded by the total size of its values in bytes. Each entry
// also expires: it lives for its ttl (or the default ttl) from the moment it was set.
// Memory is safe for concurrent use.
type Memory struct {
	mu         sync.Mutex
	maxBytes   int64
	defaultTTL time.Duration
	now        func() time.Time // clock; replaced in tests
	size       int64            // total bytes of the values currently held
	order      *list.List       // front = most recently used; elements hold *memEntry
	items      map[string]*list.Element
}

type memEntry struct {
	key     string
	value   []byte
	expires time.Time // zero means the entry never expires
}

var _ Cache = (*Memory)(nil)

// NewMemory returns an empty Memory that holds at most maxBytes of values; the least recently
// used entries are evicted to make room. maxBytes <= 0 disables storage. defaultTTL applies to
// Set calls with ttl <= 0; when it is also <= 0, entries never expire.
func NewMemory(maxBytes int64, defaultTTL time.Duration) *Memory {
	return &Memory{
		maxBytes:   maxBytes,
		defaultTTL: defaultTTL,
		now:        time.Now,
		order:      list.New(),
		items:      make(map[string]*list.Element),
	}
}

// Get returns a copy of the value for key when it is present and not expired. A hit makes the
// entry the most recently used one. An expired entry is removed.
func (m *Memory) Get(_ context.Context, key string) ([]byte, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	el, ok := m.items[key]
	if !ok {
		return nil, false
	}
	e := el.Value.(*memEntry)
	if m.expired(e) {
		m.remove(el)
		return nil, false
	}
	m.order.MoveToFront(el)
	return clone(e.value), true
}

// Set stores a copy of value under key. An existing entry for key is replaced. A value larger
// than maxBytes is not stored, and any previous entry for key is dropped so that a stale value
// is never served.
func (m *Memory) Set(_ context.Context, key string, value []byte, ttl time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if el, ok := m.items[key]; ok {
		m.remove(el)
	}
	size := int64(len(value))
	if m.maxBytes <= 0 || size > m.maxBytes {
		return
	}
	for m.size+size > m.maxBytes {
		back := m.order.Back()
		if back == nil {
			break
		}
		m.remove(back)
	}
	if ttl <= 0 {
		ttl = m.defaultTTL
	}
	e := &memEntry{key: key, value: clone(value)}
	if ttl > 0 {
		e.expires = m.now().Add(ttl)
	}
	m.items[key] = m.order.PushFront(e)
	m.size += size
}

// Len reports the number of entries held. Expired entries count until they are read or evicted.
func (m *Memory) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.order.Len()
}

// Bytes reports the total size in bytes of the values held.
func (m *Memory) Bytes() int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.size
}

// expired reports whether e has passed its expiry. The caller holds m.mu.
func (m *Memory) expired(e *memEntry) bool {
	return !e.expires.IsZero() && !m.now().Before(e.expires)
}

// remove unlinks el from the list and the index. The caller holds m.mu.
func (m *Memory) remove(el *list.Element) {
	e := m.order.Remove(el).(*memEntry)
	delete(m.items, e.key)
	m.size -= int64(len(e.value))
}

func clone(b []byte) []byte {
	c := make([]byte, len(b))
	copy(c, b)
	return c
}
