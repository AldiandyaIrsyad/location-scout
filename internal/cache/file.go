package cache

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// File is a disk cache that survives restarts. Each key lives in its own file at
// dir/<first two hex digits of sha256(key)>/<sha256(key)>. A file starts with an 8-byte
// big-endian expiry (unix nanoseconds, 0 = never) followed by the value.
// File is safe for concurrent use: writes go to a temporary file that is renamed into place.
type File struct {
	dir        string
	defaultTTL time.Duration
	now        func() time.Time // clock; replaced in tests
}

const (
	fileHeaderSize = 8
	fileKeyHexLen  = sha256.Size * 2
	tmpFilePrefix  = ".tmp-"
	staleTmpAge    = time.Hour // temporary files older than this are leftovers of a crash
)

var _ Cache = (*File)(nil)

// NewFile creates (if needed) dir and returns a disk cache rooted there. defaultTTL applies to
// Set calls with ttl <= 0; when it is also <= 0, entries never expire.
func NewFile(dir string, defaultTTL time.Duration) (*File, error) {
	if dir == "" {
		return nil, errors.New("cache: file cache directory is empty")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("cache: create %s: %w", dir, err)
	}
	return &File{dir: dir, defaultTTL: defaultTTL, now: time.Now}, nil
}

// Get returns the value for key when the file exists and has not expired. An expired or
// unreadable (truncated) file is deleted and reported as a miss.
func (f *File) Get(_ context.Context, key string) ([]byte, bool) {
	p := f.path(key)
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, false
	}
	if len(data) < fileHeaderSize {
		_ = os.Remove(p)
		return nil, false
	}
	exp := int64(binary.BigEndian.Uint64(data[:fileHeaderSize]))
	if exp != 0 && f.now().UnixNano() >= exp {
		_ = os.Remove(p)
		return nil, false
	}
	return data[fileHeaderSize:], true
}

// Set writes value under key. Errors are ignored: the cache is best effort and a failed write
// only costs a later miss. The write is atomic, so readers never see a partial file.
func (f *File) Set(_ context.Context, key string, value []byte, ttl time.Duration) {
	if ttl <= 0 {
		ttl = f.defaultTTL
	}
	var exp int64
	if ttl > 0 {
		exp = f.now().Add(ttl).UnixNano()
	}
	p := f.path(key)
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	tmp, err := os.CreateTemp(dir, tmpFilePrefix+"*")
	if err != nil {
		return
	}
	committed := false
	defer func() {
		if !committed {
			_ = tmp.Close()
			_ = os.Remove(tmp.Name())
		}
	}()
	var hdr [fileHeaderSize]byte
	binary.BigEndian.PutUint64(hdr[:], uint64(exp))
	if _, err := tmp.Write(hdr[:]); err != nil {
		return
	}
	if _, err := tmp.Write(value); err != nil {
		return
	}
	if err := tmp.Close(); err != nil {
		return
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		return
	}
	committed = true
}

// Prune walks the cache directory and deletes every expired entry, every entry whose header is
// unreadable, and temporary files left behind by an interrupted write. It stops early with
// ctx's error when the context is cancelled. Files it does not recognise are left alone.
func (f *File) Prune(ctx context.Context) error {
	now := f.now()
	return filepath.WalkDir(f.dir, func(p string, d fs.DirEntry, err error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err != nil || d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, tmpFilePrefix) {
			if info, err := d.Info(); err == nil && now.Sub(info.ModTime()) > staleTmpAge {
				_ = os.Remove(p)
			}
			return nil
		}
		if len(name) != fileKeyHexLen {
			return nil
		}
		if expiredFile(p, now) {
			_ = os.Remove(p)
		}
		return nil
	})
}

// expiredFile reads only the header of the entry at p and reports whether it is expired or
// truncated.
func expiredFile(p string, now time.Time) bool {
	fh, err := os.Open(p)
	if err != nil {
		return false
	}
	defer fh.Close()
	var hdr [fileHeaderSize]byte
	if _, err := io.ReadFull(fh, hdr[:]); err != nil {
		return true
	}
	exp := int64(binary.BigEndian.Uint64(hdr[:]))
	return exp != 0 && now.UnixNano() >= exp
}

// path maps a key to its file location.
func (f *File) path(key string) string {
	sum := sha256.Sum256([]byte(key))
	name := hex.EncodeToString(sum[:])
	return filepath.Join(f.dir, name[:2], name)
}
