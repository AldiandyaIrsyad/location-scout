package snapshot

import (
	"context"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"panelscape/internal/upstream"
)

// fake is a live fetcher that counts calls and can be made to fail.
type fake struct {
	body  []byte
	err   error
	calls int
}

func (f *fake) Get(context.Context, string, time.Duration) ([]byte, error) {
	f.calls++
	return f.body, f.err
}

func (f *fake) PostForm(context.Context, string, url.Values, time.Duration) ([]byte, error) {
	f.calls++
	return f.body, f.err
}

var ctx = context.Background()

func TestDirRoundTripAndMisses(t *testing.T) {
	d := NewDir(filepath.Join(t.TempDir(), "nested", "snap"))
	if d.Exists() {
		t.Fatal("a directory that was never written exists")
	}
	if _, ok := d.Get("GET x"); ok {
		t.Fatal("miss in a missing directory reported a hit")
	}
	body := []byte(`{"elements":[]}`)
	name, err := d.Put("GET x", body)
	if err != nil {
		t.Fatal(err)
	}
	if name != FileName("GET x") || !d.Exists() {
		t.Fatalf("stored as %q", name)
	}
	if got, ok := d.Get("GET x"); !ok || string(got) != string(body) {
		t.Fatalf("round trip: %q, %v", got, ok)
	}
	if _, ok := d.Get("GET y"); ok {
		t.Fatal("another key must miss")
	}
	// A file that is not gzip (a truncated copy, a stray file) is a miss rather than garbage served as data.
	if err := os.WriteFile(filepath.Join(d.Path(), FileName("GET bad")), []byte("not gzip"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := d.Get("GET bad"); ok {
		t.Fatal("corrupt file must be a miss")
	}
	if leftovers, _ := filepath.Glob(filepath.Join(d.Path(), "*.tmp")); len(leftovers) != 0 {
		t.Fatalf("temporary files left behind: %v", leftovers)
	}
}

func TestKeys(t *testing.T) {
	if PostKey(url.Values{"data": {"q"}}) != PostKey(url.Values{"data": {"q"}}) {
		t.Fatal("same form, different key")
	}
	if PostKey(url.Values{"data": {"q1"}}) == PostKey(url.Values{"data": {"q2"}}) {
		t.Fatal("different queries must not share a key")
	}
	if GetKey("https://a/1") == GetKey("https://a/2") {
		t.Fatal("different URLs must not share a key")
	}
	if GetKey("https://a/1") == PostKey(url.Values{"x": {"1"}}) {
		t.Fatal("GET and POST keys overlap")
	}
}

func TestParseMode(t *testing.T) {
	for in, want := range map[string]Mode{"": ModePrefer, " Prefer ": ModePrefer, "ONLY": ModeOnly, "off": ModeOff} {
		if got, err := ParseMode(in); err != nil || got != want {
			t.Errorf("ParseMode(%q) = %q, %v", in, got, err)
		}
	}
	if _, err := ParseMode("sometimes"); err == nil {
		t.Error("unknown mode accepted")
	}
}

func TestFetcherModes(t *testing.T) {
	d := NewDir(t.TempDir())
	form := url.Values{"data": {"query"}}
	d.Put(PostKey(form), []byte("recorded post"))
	d.Put(GetKey("https://tiles/1"), []byte("recorded get"))

	cases := []struct {
		name     string
		mode     Mode
		call     func(f *Fetcher) ([]byte, error)
		want     string
		wantErr  error
		liveHits int
	}{
		{"prefer serves a recorded POST from a different mirror", ModePrefer, func(f *Fetcher) ([]byte, error) { return f.PostForm(ctx, "https://other-mirror/api", form, 0) }, "recorded post", nil, 0},
		{"prefer serves a recorded GET", ModePrefer, func(f *Fetcher) ([]byte, error) { return f.Get(ctx, "https://tiles/1", 0) }, "recorded get", nil, 0},
		{"prefer goes live for an unrecorded form", ModePrefer, func(f *Fetcher) ([]byte, error) {
			return f.PostForm(ctx, "https://m/api", url.Values{"data": {"other"}}, 0)
		}, "live", nil, 1},
		{"prefer goes live for an unrecorded URL", ModePrefer, func(f *Fetcher) ([]byte, error) { return f.Get(ctx, "https://tiles/2", 0) }, "live", nil, 1},
		{"only serves a recorded response", ModeOnly, func(f *Fetcher) ([]byte, error) { return f.Get(ctx, "https://tiles/1", 0) }, "recorded get", nil, 0},
		{"only refuses an unrecorded one without going live", ModeOnly, func(f *Fetcher) ([]byte, error) { return f.Get(ctx, "https://tiles/2", 0) }, "", ErrNotSnapshotted, 0},
		{"off ignores the recording", ModeOff, func(f *Fetcher) ([]byte, error) { return f.Get(ctx, "https://tiles/1", 0) }, "live", nil, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			live := &fake{body: []byte("live")}
			got, err := c.call(NewFetcher(live, d, c.mode))
			if !errors.Is(err, c.wantErr) {
				t.Fatalf("err = %v, want %v", err, c.wantErr)
			}
			if string(got) != c.want {
				t.Fatalf("body = %q, want %q", got, c.want)
			}
			if live.calls != c.liveHits {
				t.Fatalf("live fetcher called %d times, want %d", live.calls, c.liveHits)
			}
		})
	}
}

func TestOnlyModeErrorIsNotRetryableByTheOSMService(t *testing.T) {
	// The OSM service retries anything that is not upstream.ErrNotFound; a refusal retried three times over
	// three mirrors would delay the error for nothing.
	if !errors.Is(ErrNotSnapshotted, upstream.ErrNotFound) {
		t.Fatal("ErrNotSnapshotted must wrap upstream.ErrNotFound")
	}
}

func TestRecorderKeepsSuccessesOnly(t *testing.T) {
	d := NewDir(t.TempDir())
	live := &fake{body: []byte("tile bytes")}
	r := NewRecorder(live, d)

	if _, err := r.Get(ctx, "https://tiles/1", 0); err != nil {
		t.Fatal(err)
	}
	live.err = errors.New("502")
	if _, err := r.Get(ctx, "https://tiles/2", 0); err == nil {
		t.Fatal("live error swallowed")
	}
	entries, err := r.Drain()
	if err != nil || len(entries) != 1 || entries[0].URL != "https://tiles/1" || entries[0].Bytes != len("tile bytes") {
		t.Fatalf("entries = %+v, err = %v", entries, err)
	}
	if _, ok := d.Get(GetKey("https://tiles/2")); ok {
		t.Fatal("a failed request was recorded")
	}
	if again, _ := r.Drain(); len(again) != 0 {
		t.Fatal("Drain must hand each entry out once")
	}
}

func TestRecordedResponsesServeWhenLiveIsDown(t *testing.T) {
	d := NewDir(t.TempDir())
	form := url.Values{"data": {"[out:json];node(1);out;"}}
	rec := NewRecorder(&fake{body: []byte(`{"elements":[1]}`)}, d)
	if _, err := rec.PostForm(ctx, "https://mirror-a/api", form, 0); err != nil {
		t.Fatal(err)
	}

	down := &fake{err: errors.New("network down")}
	f := NewFetcher(down, d, ModePrefer)
	got, err := f.PostForm(ctx, "https://mirror-b/api", form, 0)
	if err != nil || string(got) != `{"elements":[1]}` {
		t.Fatalf("got %q, %v", got, err)
	}
	if down.calls != 0 {
		t.Fatal("went live although the response was recorded")
	}
}

func TestManifestMergesByPlaceAndSortsOnSave(t *testing.T) {
	dir := t.TempDir()
	m, err := LoadManifest(dir)
	if err != nil || len(m.Places) != 0 {
		t.Fatalf("empty dir: %+v, %v", m, err)
	}
	m.Set(PlaceRecord{Name: "Zeta", Size: 300})
	m.Set(PlaceRecord{Name: "Alpha", Size: 300})
	m.Set(PlaceRecord{Name: "Zeta", Size: 400}) // re-recording replaces, not duplicates
	if err := m.Save(dir); err != nil {
		t.Fatal(err)
	}
	back, err := LoadManifest(dir)
	if err != nil || len(back.Places) != 2 || back.Places[0].Name != "Alpha" || back.Places[1].Size != 400 {
		t.Fatalf("round trip: %+v, %v", back, err)
	}
	if err := os.WriteFile(filepath.Join(dir, ManifestFile), []byte("{broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadManifest(dir); err == nil {
		t.Fatal("a corrupt manifest must be an error, not an empty list")
	}
}
