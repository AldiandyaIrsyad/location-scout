package osm

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"panelscape/internal/snapshot"
)

// A place recorded once through the snapshot recorder comes back identical from a service whose live side is
// down and whose snapshot mode forbids going live: the whole offline path, from query to parsed result.
func TestCityAndSurroundingsServeOfflineFromARecordedSnapshot(t *testing.T) {
	raw := loadSample(t)
	dir := snapshot.NewDir(t.TempDir())
	ctx := context.Background()

	recording := NewService(snapshot.NewRecorder(newFakeFetcher(raw), dir), []string{urlA}, time.Hour, nil, time.Hour, nil)
	wantCity, err := recording.City(ctx, testLat, testLon, testSize, 7)
	if err != nil {
		t.Fatal(err)
	}
	wantSur, err := recording.Surroundings(ctx, testLat, testLon, testSize, 2000)
	if err != nil {
		t.Fatal(err)
	}

	// The offline service talks to a different mirror, which is down: the query must still be found.
	down := newFakeFetcher(nil)
	down.fail[urlB] = errors.New("network down")
	offline := NewService(snapshot.NewFetcher(down, dir, snapshot.ModeOnly), []string{urlB}, time.Hour, nil, time.Hour, nil)

	gotCity, err := offline.City(ctx, testLat, testLon, testSize, 7)
	if err != nil {
		t.Fatalf("offline city: %v", err)
	}
	gotSur, err := offline.Surroundings(ctx, testLat, testLon, testSize, 2000)
	if err != nil {
		t.Fatalf("offline surroundings: %v", err)
	}
	if down.count(urlB) != 0 {
		t.Fatal("went live although the query was recorded (on another mirror)")
	}
	for name, pair := range map[string][2]any{"city": {wantCity, gotCity}, "surroundings": {wantSur, gotSur}} {
		a, _ := json.Marshal(pair[0])
		b, _ := json.Marshal(pair[1])
		if string(a) != string(b) {
			t.Errorf("offline %s differs from the recorded one", name)
		}
	}

	// An area that was never recorded must fail at once instead of retrying every mirror for a minute.
	if _, err := offline.City(ctx, testLat+0.5, testLon, testSize, 7); !errors.Is(err, snapshot.ErrNotSnapshotted) {
		t.Fatalf("unrecorded area: %v", err)
	}
	if down.count(urlB) != 0 {
		t.Fatal("an unrecorded area reached the live fetcher in only mode")
	}
}
