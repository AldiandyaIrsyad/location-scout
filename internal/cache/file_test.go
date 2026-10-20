package cache

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// filePathFor returns where the entry for key must live, independent of File.path.
func filePathFor(dir, key string) string {
	sum := sha256.Sum256([]byte(key))
	name := hex.EncodeToString(sum[:])
	return filepath.Join(dir, name[:2], name)
}

func newTestFile(t *testing.T, dir string, ttl time.Duration) *File {
	t.Helper()
	f, err := NewFile(dir, ttl)
	if err != nil {
		t.Fatalf("NewFile: %v", err)
	}
	return f
}

func TestNewFileRejectsEmptyDir(t *testing.T) {
	if _, err := NewFile("", time.Minute); err == nil {
		t.Fatal("expected error for empty directory")
	}
}

func TestNewFileCreatesDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "cache")
	newTestFile(t, dir, time.Minute)
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		t.Fatalf("directory not created: %v", err)
	}
}

func TestFileSetGet(t *testing.T) {
	ctx := context.Background()
	f := newTestFile(t, t.TempDir(), time.Minute)

	if _, ok := f.Get(ctx, "missing"); ok {
		t.Fatal("expected miss for unknown key")
	}
	f.Set(ctx, "k", []byte("value"), 0)
	v, ok := f.Get(ctx, "k")
	if !ok || string(v) != "value" {
		t.Fatalf("Get(k) = %q, %v; want value, true", v, ok)
	}
}

func TestFileEmptyValue(t *testing.T) {
	ctx := context.Background()
	f := newTestFile(t, t.TempDir(), time.Minute)
	f.Set(ctx, "empty", nil, 0)
	v, ok := f.Get(ctx, "empty")
	if !ok || len(v) != 0 {
		t.Fatalf("Get(empty) = %q, %v; want empty, true", v, ok)
	}
}

func TestFileOverwrite(t *testing.T) {
	ctx := context.Background()
	f := newTestFile(t, t.TempDir(), time.Minute)
	f.Set(ctx, "k", []byte("first and longer"), 0)
	f.Set(ctx, "k", []byte("second"), 0)
	v, ok := f.Get(ctx, "k")
	if !ok || string(v) != "second" {
		t.Fatalf("Get(k) = %q, %v; want second, true", v, ok)
	}
}

func TestFileShardedLayout(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	f := newTestFile(t, dir, time.Minute)
	f.Set(ctx, "some-key", []byte("v"), 0)

	p := filePathFor(dir, "some-key")
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("expected entry at %s: %v", p, err)
	}
	if got := filepath.Base(filepath.Dir(p)); len(got) != 2 {
		t.Fatalf("shard directory %q should be two hex digits", got)
	}
}

func TestFileNoTempFilesLeftBehind(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	f := newTestFile(t, dir, time.Minute)
	for i := 0; i < 20; i++ {
		f.Set(ctx, fmt.Sprint("k", i%5), []byte("x"), 0)
	}
	var tmps []string
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && strings.HasPrefix(d.Name(), tmpFilePrefix) {
			tmps = append(tmps, p)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(tmps) != 0 {
		t.Fatalf("temporary files left behind: %v", tmps)
	}
}

func TestFilePersistsAcrossInstances(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()

	first := newTestFile(t, dir, time.Hour)
	first.Set(ctx, "persist", []byte("still here"), 0)

	second := newTestFile(t, dir, time.Hour) // simulates a restart
	v, ok := second.Get(ctx, "persist")
	if !ok || string(v) != "still here" {
		t.Fatalf("Get after restart = %q, %v; want still here, true", v, ok)
	}
}

func TestFileExpiryDeletesEntry(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	clock := newFakeClock()
	f := newTestFile(t, dir, time.Minute)
	f.now = clock.now

	f.Set(ctx, "k", []byte("v"), time.Second)
	clock.advance(500 * time.Millisecond)
	if _, ok := f.Get(ctx, "k"); !ok {
		t.Fatal("entry should be live before its ttl")
	}

	clock.advance(time.Second)
	if _, ok := f.Get(ctx, "k"); ok {
		t.Fatal("entry should have expired")
	}
	if _, err := os.Stat(filePathFor(dir, "k")); !os.IsNotExist(err) {
		t.Fatalf("expired file should be deleted on read, stat err=%v", err)
	}
}

func TestFileDefaultTTL(t *testing.T) {
	ctx := context.Background()
	clock := newFakeClock()
	f := newTestFile(t, t.TempDir(), 10*time.Second)
	f.now = clock.now

	f.Set(ctx, "k", []byte("v"), 0)
	clock.advance(9 * time.Second)
	if _, ok := f.Get(ctx, "k"); !ok {
		t.Fatal("entry should live for the default ttl")
	}
	clock.advance(2 * time.Second)
	if _, ok := f.Get(ctx, "k"); ok {
		t.Fatal("entry should expire after the default ttl")
	}
}

func TestFileNoExpiryWhenNoTTL(t *testing.T) {
	ctx := context.Background()
	clock := newFakeClock()
	f := newTestFile(t, t.TempDir(), 0)
	f.now = clock.now

	f.Set(ctx, "k", []byte("v"), 0)
	clock.advance(100 * 365 * 24 * time.Hour)
	if _, ok := f.Get(ctx, "k"); !ok {
		t.Fatal("entry without any ttl should never expire")
	}
}

func TestFileTruncatedFileIsMissAndRemoved(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	f := newTestFile(t, dir, time.Minute)

	p := filePathFor(dir, "broken")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte{1, 2, 3}, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.Get(ctx, "broken"); ok {
		t.Fatal("truncated file must be a miss")
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatalf("truncated file should be removed, stat err=%v", err)
	}
}

func TestFilePruneRemovesOnlyExpired(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	clock := newFakeClock()
	f := newTestFile(t, dir, time.Minute)
	f.now = clock.now

	f.Set(ctx, "expired", []byte("e"), time.Second)
	f.Set(ctx, "live", []byte("l"), time.Hour)
	clock.advance(2 * time.Second)

	// An entry with no expiry at all (written by an instance without a default ttl).
	noExp := newTestFile(t, dir, 0)
	noExp.now = clock.now
	noExp.Set(ctx, "never", []byte("n"), 0)

	if err := f.Prune(ctx); err != nil {
		t.Fatalf("Prune: %v", err)
	}
	if _, err := os.Stat(filePathFor(dir, "expired")); !os.IsNotExist(err) {
		t.Fatal("expired entry should be pruned")
	}
	for _, k := range []string{"live", "never"} {
		if _, err := os.Stat(filePathFor(dir, k)); err != nil {
			t.Fatalf("%s should survive pruning: %v", k, err)
		}
	}
	if _, ok := f.Get(ctx, "live"); !ok {
		t.Fatal("live entry should still be readable")
	}
}

func TestFilePruneRemovesCorruptAndStaleTempFiles(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	f := newTestFile(t, dir, time.Minute) // real clock: temp-file age is measured against it
	f.Set(ctx, "good", []byte("g"), 0)

	corrupt := filePathFor(dir, "corrupt")
	if err := os.MkdirAll(filepath.Dir(corrupt), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(corrupt, []byte{9}, 0o644); err != nil {
		t.Fatal(err)
	}

	stale := filepath.Join(filepath.Dir(corrupt), tmpFilePrefix+"old")
	if err := os.WriteFile(stale, []byte("partial"), 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * staleTmpAge)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	fresh := filepath.Join(filepath.Dir(corrupt), tmpFilePrefix+"new")
	if err := os.WriteFile(fresh, []byte("in progress"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := f.Prune(ctx); err != nil {
		t.Fatalf("Prune: %v", err)
	}
	if _, err := os.Stat(corrupt); !os.IsNotExist(err) {
		t.Fatal("corrupt entry should be pruned")
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("stale temp file should be pruned")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("fresh temp file (write in progress) must be kept")
	}
	if _, ok := f.Get(ctx, "good"); !ok {
		t.Fatal("valid entry should survive pruning")
	}
}

func TestFilePruneHonoursCancelledContext(t *testing.T) {
	f := newTestFile(t, t.TempDir(), time.Minute)
	f.Set(context.Background(), "k", []byte("v"), 0)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := f.Prune(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Prune with cancelled context = %v; want context.Canceled", err)
	}
}

func TestFileConcurrentAccess(t *testing.T) {
	ctx := context.Background()
	f := newTestFile(t, t.TempDir(), time.Minute)

	const writers = 8
	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				// Every writer stores uniform payloads, so a torn read would show mixed bytes.
				val := bytes.Repeat([]byte{byte('a' + w)}, 4096)
				f.Set(ctx, "shared", val, 0)
				f.Set(ctx, fmt.Sprint("own", w), val, 0)
			}
		}(w)
	}
	for r := 0; r < 4; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				v, ok := f.Get(ctx, "shared")
				if !ok {
					continue
				}
				if len(v) != 4096 || bytes.Count(v, v[:1]) != 4096 {
					t.Errorf("torn read: len=%d", len(v))
					return
				}
			}
		}()
	}
	wg.Wait()

	for w := 0; w < writers; w++ {
		v, ok := f.Get(ctx, fmt.Sprint("own", w))
		if !ok || len(v) != 4096 {
			t.Fatalf("own%d: ok=%v len=%d", w, ok, len(v))
		}
	}
}
