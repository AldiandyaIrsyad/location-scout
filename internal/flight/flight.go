// Package flight suppresses duplicate work: concurrent calls with the same key share one execution
// of the function and all receive its result.
package flight

import (
	"errors"
	"sync"
)

// errPanicked is returned to callers that were waiting on a call whose function panicked.
var errPanicked = errors.New("flight: function panicked")

// Group runs at most one function per key at a time. The zero value is ready to use.
// A Group must not be copied after first use.
type Group struct {
	mu sync.Mutex
	m  map[string]*call
}

type call struct {
	wg   sync.WaitGroup
	val  []byte
	err  error
	dups int // number of callers that joined this call; guarded by Group.mu
}

// Do runs fn for key unless a call for key is already in flight, in which case it waits for that
// call and returns its result. shared reports whether the result was shared with other callers.
// The returned slice is shared by all callers and must not be modified.
// If fn panics, the panic propagates to the caller that ran fn; waiting callers receive an error.
func (g *Group) Do(key string, fn func() ([]byte, error)) (v []byte, err error, shared bool) {
	g.mu.Lock()
	if g.m == nil {
		g.m = make(map[string]*call)
	}
	if c, ok := g.m[key]; ok {
		c.dups++
		g.mu.Unlock()
		c.wg.Wait()
		return c.val, c.err, true
	}
	c := new(call)
	c.wg.Add(1)
	g.m[key] = c
	g.mu.Unlock()

	g.run(c, key, fn)
	g.mu.Lock()
	dups := c.dups
	g.mu.Unlock()
	return c.val, c.err, dups > 0
}

// run executes fn and publishes its result. The key is always released, even on panic, so a
// later call with the same key runs again instead of hanging.
func (g *Group) run(c *call, key string, fn func() ([]byte, error)) {
	completed := false
	defer func() {
		if !completed {
			c.err = errPanicked
		}
		g.mu.Lock()
		delete(g.m, key)
		g.mu.Unlock()
		c.wg.Done()
	}()
	c.val, c.err = fn()
	completed = true
}
