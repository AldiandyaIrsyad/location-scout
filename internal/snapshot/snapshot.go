// Package snapshot serves recorded upstream responses (Overpass results, elevation tiles) from disk, so
// the built-in places load without contacting any third-party server. A Fetcher decorates the live
// upstream.Fetcher: depending on the mode it answers from the snapshot first, only from it, or not at all.
// A Recorder does the opposite and saves every successful response into a snapshot directory.
//
// Requests are keyed by what was asked, not by which server answered, so a response recorded from one
// Overpass mirror serves a request that would have gone to another.
package snapshot

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"panelscape/internal/upstream"
)

// Mode says how a Fetcher combines the snapshot with the live fetcher.
type Mode string

const (
	// ModePrefer answers from the snapshot when it has the response and goes live otherwise.
	ModePrefer Mode = "prefer"
	// ModeOnly never goes live: a request without a snapshot fails with ErrNotSnapshotted.
	ModeOnly Mode = "only"
	// ModeOff ignores the snapshot and always goes live.
	ModeOff Mode = "off"
)

// ParseMode reads a mode name; an empty string means ModePrefer.
func ParseMode(s string) (Mode, error) {
	switch m := Mode(strings.ToLower(strings.TrimSpace(s))); m {
	case "":
		return ModePrefer, nil
	case ModePrefer, ModeOnly, ModeOff:
		return m, nil
	}
	return "", fmt.Errorf("snapshot: unknown mode %q (want prefer, only or off)", s)
}

// ErrNotSnapshotted is returned in ModeOnly for a request the snapshot does not hold. It wraps
// upstream.ErrNotFound, so callers that retry only on busy upstreams do not retry it.
var ErrNotSnapshotted = fmt.Errorf("no bundled snapshot for this request and live data is turned off: %w", upstream.ErrNotFound)

// GetKey names a GET request: the URL decides the answer.
func GetKey(rawURL string) string { return "GET " + rawURL }

// PostKey names a form POST by its form alone. The URL is left out on purpose: an Overpass query gets
// the same answer from every mirror, and the service falls back between mirrors.
func PostKey(form url.Values) string { return "POST " + form.Encode() }

// FileName is the file a key is stored in.
func FileName(key string) string {
	h := sha256.Sum256([]byte(key))
	return hex.EncodeToString(h[:]) + ".gz"
}

// Store reads recorded responses.
type Store interface {
	Get(key string) ([]byte, bool)
}

// Writer saves responses and returns the file name they were stored under.
type Writer interface {
	Put(key string, body []byte) (file string, err error)
}

// Dir is a Store and Writer over a directory of gzip files, one per response.
type Dir struct {
	path string
}

var (
	_ Store  = (*Dir)(nil)
	_ Writer = (*Dir)(nil)
)

// NewDir returns a snapshot directory. The directory need not exist to read from it.
func NewDir(path string) *Dir { return &Dir{path: path} }

// Path is the directory.
func (d *Dir) Path() string { return d.path }

// Exists reports whether the directory is there.
func (d *Dir) Exists() bool {
	info, err := os.Stat(d.path)
	return err == nil && info.IsDir()
}

// Get returns the recorded body for key. A missing or unreadable file is a miss.
func (d *Dir) Get(key string) ([]byte, bool) {
	f, err := os.Open(filepath.Join(d.path, FileName(key)))
	if err != nil {
		return nil, false
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return nil, false
	}
	defer zr.Close()
	body, err := io.ReadAll(zr)
	if err != nil {
		return nil, false
	}
	return body, true
}

// Put compresses body into the directory (created if needed), through a temporary file so a reader never
// sees a half-written response.
func (d *Dir) Put(key string, body []byte) (string, error) {
	if err := os.MkdirAll(d.path, 0o755); err != nil {
		return "", err
	}
	name := FileName(key)
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if _, err := zw.Write(body); err != nil {
		return "", err
	}
	if err := zw.Close(); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(d.path, "*.tmp")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(buf.Bytes()); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(tmp.Name(), filepath.Join(d.path, name)); err != nil {
		return "", err
	}
	return name, nil
}

// Fetcher answers from a Store according to its Mode and otherwise defers to the live fetcher.
type Fetcher struct {
	live  upstream.Fetcher
	store Store
	mode  Mode
}

var _ upstream.Fetcher = (*Fetcher)(nil)

// NewFetcher returns a fetcher over live. A nil store behaves as an empty one.
func NewFetcher(live upstream.Fetcher, store Store, mode Mode) *Fetcher {
	return &Fetcher{live: live, store: store, mode: mode}
}

// Mode reports how the fetcher uses its snapshot.
func (f *Fetcher) Mode() Mode { return f.mode }

func (f *Fetcher) lookup(key string) ([]byte, bool, error) {
	if f.mode == ModeOff {
		return nil, false, nil
	}
	if f.store != nil {
		if body, ok := f.store.Get(key); ok {
			return body, true, nil
		}
	}
	if f.mode == ModeOnly {
		return nil, false, ErrNotSnapshotted
	}
	return nil, false, nil
}

// Get implements upstream.Fetcher.
func (f *Fetcher) Get(ctx context.Context, rawURL string, ttl time.Duration) ([]byte, error) {
	body, ok, err := f.lookup(GetKey(rawURL))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", rawURL, err)
	}
	if ok {
		return body, nil
	}
	return f.live.Get(ctx, rawURL, ttl)
}

// PostForm implements upstream.Fetcher.
func (f *Fetcher) PostForm(ctx context.Context, rawURL string, form url.Values, ttl time.Duration) ([]byte, error) {
	body, ok, err := f.lookup(PostKey(form))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", rawURL, err)
	}
	if ok {
		return body, nil
	}
	return f.live.PostForm(ctx, rawURL, form, ttl)
}

// Entry describes one recorded response.
type Entry struct {
	Method string `json:"method"`
	URL    string `json:"url"` // the URL asked (for a POST, the server that answered)
	File   string `json:"file"`
	Bytes  int    `json:"bytes"` // uncompressed size
}

// Recorder decorates a live fetcher and saves every successful response through a Writer. It sits above
// the fetcher's own cache, so cached responses are recorded too. Safe for concurrent use.
type Recorder struct {
	live upstream.Fetcher
	w    Writer
	mu   sync.Mutex
	seen []Entry
	err  error
}

var _ upstream.Fetcher = (*Recorder)(nil)

// NewRecorder returns a recording fetcher.
func NewRecorder(live upstream.Fetcher, w Writer) *Recorder {
	return &Recorder{live: live, w: w}
}

func (r *Recorder) record(method, rawURL, key string, body []byte) {
	file, err := r.w.Put(key, body)
	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil {
		r.err = errors.Join(r.err, fmt.Errorf("record %s: %w", rawURL, err))
		return
	}
	r.seen = append(r.seen, Entry{Method: method, URL: rawURL, File: file, Bytes: len(body)})
}

// Get implements upstream.Fetcher.
func (r *Recorder) Get(ctx context.Context, rawURL string, ttl time.Duration) ([]byte, error) {
	body, err := r.live.Get(ctx, rawURL, ttl)
	if err == nil {
		r.record("GET", rawURL, GetKey(rawURL), body)
	}
	return body, err
}

// PostForm implements upstream.Fetcher.
func (r *Recorder) PostForm(ctx context.Context, rawURL string, form url.Values, ttl time.Duration) ([]byte, error) {
	body, err := r.live.PostForm(ctx, rawURL, form, ttl)
	if err == nil {
		r.record("POST", rawURL, PostKey(form), body)
	}
	return body, err
}

// Drain returns what was recorded since the last call, and any error from writing it.
func (r *Recorder) Drain() ([]Entry, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out, err := r.seen, r.err
	r.seen, r.err = nil, nil
	return out, err
}
