package osm

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"

	"panelscape/internal/geo"
)

func square(x0, y0, x1, y1 float64) []geo.Point {
	return []geo.Point{{x0, y0}, {x1, y0}, {x1, y1}, {x0, y1}}
}

func TestGenerateTreesDoesNotInventBoulevardOrGrassParkTrees(t *testing.T) {
	c := &collected{
		roads: []Road{{ID: "main", Kind: "primary", Width: 10, Points: []geo.Point{{-50, 0}, {50, 0}}}},
		green: []Area{
			{Kind: "park", Outer: square(-45, -45, 45, 45)},
			{Kind: "grass", Outer: square(-30, -30, 30, 30)},
			{Kind: "meadow", Outer: square(-20, -20, 20, 20)},
		},
		trees: []geo.Point{{-10, -10}, {10, 10}},
	}

	got := generateTrees(c, nil, 100)
	if len(got) != 0 {
		t.Fatalf("generated %d trees in non-canopy areas, want none: %v", len(got), got)
	}
	if !reflect.DeepEqual(c.trees, []geo.Point{{-10, -10}, {10, 10}}) {
		t.Fatalf("mapped trees changed: %v", c.trees)
	}
}

func TestGenerateTreesKeepsCanopyOutOfObstacles(t *testing.T) {
	wood := Area{Kind: "wood", Outer: square(-45, -45, 45, 45)}
	water := Area{Kind: "water", Outer: square(-12, -12, 12, 12)}
	parking := Area{Kind: "parking", Outer: square(20, -16, 38, 16)}
	building := Building{
		Outer: square(-38, 19, -22, 35),
		Holes: [][]geo.Point{square(-34, 23, -26, 29)},
	}
	c := &collected{
		roads: []Road{{ID: "path", Kind: "path", Width: 4, Points: []geo.Point{{-45, 35}, {45, 35}}}},
		water: []Area{water},
		areas: []Area{parking},
		green: []Area{wood},
	}

	got := generateTrees(c, []Building{building}, 100)
	if len(got) == 0 {
		t.Fatal("wood canopy produced no inferred trees")
	}
	for _, p := range got {
		if !pointInRing(p[0], p[1], wood.Outer) {
			t.Errorf("tree %v is outside wood canopy", p)
		}
		if pointInRing(p[0], p[1], water.Outer) {
			t.Errorf("tree %v is in water", p)
		}
		if pointInRing(p[0], p[1], parking.Outer) {
			t.Errorf("tree %v is in parking", p)
		}
		if d, _ := closestOnLine(c.roads[0].Points, p); d <= c.roads[0].Width/2+1.5 {
			t.Errorf("tree %v is in path clearance (distance %.2f)", p, d)
		}
		if pointInRing(p[0], p[1], building.Outer) || pointInRing(p[0], p[1], building.Holes[0]) {
			t.Errorf("tree %v is in building footprint or hole", p)
		}
	}
}

func TestGenerateTreesIsDeterministicAndBounded(t *testing.T) {
	c := &collected{green: []Area{{Kind: "forest", Outer: square(-5000, -5000, 5000, 5000)}}}
	one := generateTrees(c, nil, 10000)
	two := generateTrees(c, nil, 10000)
	if !reflect.DeepEqual(one, two) {
		t.Fatal("inferred tree placement is not deterministic")
	}
	if len(one) > inferredTreeBudget {
		t.Fatalf("generated %d trees, budget is %d", len(one), inferredTreeBudget)
	}
	if len(one) < inferredTreeBudget/2 {
		t.Fatalf("large forest generated only %d trees, want most of the %d budget", len(one), inferredTreeBudget)
	}
}

func TestGenerateTreesSpreadsBudgetAcrossAllCanopy(t *testing.T) {
	// One wood alone wants far more trees than the budget; a second, small one must still get some
	// and the big one must be covered end to end, not just along its west edge.
	big := Area{Kind: "forest", Outer: square(-1500, -1500, 1500, 1500)}
	small := Area{Kind: "wood", Outer: square(1600, 1600, 1700, 1700)}
	c := &collected{green: []Area{big, small}}
	got := generateTrees(c, nil, 4000)

	var inSmall, east, west, north, south int
	for _, p := range got {
		switch {
		case pointInRing(p[0], p[1], small.Outer):
			inSmall++
		case p[0] > 0:
			east++
		default:
			west++
		}
		if p[1] > 0 {
			north++
		} else {
			south++
		}
	}
	if inSmall == 0 {
		t.Errorf("second wood got no trees; first wood used the whole budget")
	}
	for name, n := range map[string]int{"east": east, "west": west, "north": north, "south": south} {
		if n < len(got)/5 {
			t.Errorf("only %d of %d trees in the %s half; canopy is not covered evenly", n, len(got), name)
		}
	}
}

func TestGenerateTreesKeepsGlobalRoadAndAreaExclusions(t *testing.T) {
	// The city extent is intentionally large enough that these long features
	// exceed maxSpatialCells after clamping and use the global fallback.
	c := &collected{
		roads: []Road{{
			ID: "long-road", Width: 4,
			Points: []geo.Point{{-10000, 0}, {10000, 0}},
		}},
		water: []Area{{Kind: "water", Outer: square(-10000, 20, 10000, 26)}},
		green: []Area{{Kind: "forest", Outer: square(-45, -45, 45, 45)}},
	}

	got := generateTrees(c, nil, 10000)
	if len(got) == 0 {
		t.Fatal("global exclusions removed every canopy tree")
	}
	for _, p := range got {
		if d, _ := closestOnLine(c.roads[0].Points, p); d <= c.roads[0].Width/2+1.5 {
			t.Errorf("tree %v is inside long-road clearance (distance %.2f)", p, d)
		}
		if pointInRing(p[0], p[1], c.water[0].Outer) {
			t.Errorf("tree %v is inside global water exclusion", p)
		}
	}
}

func TestGenerateTreesIndexedOutputIsStableAcrossObstacleIndexing(t *testing.T) {
	// This fixture combines indexed multi-segment corridors, a wide global
	// corridor, area holes and mapped points. The hash was derived from the
	// pre-index implementation and protects exact placement order as well as
	// obstacle exclusion semantics.
	c := &collected{
		roads: []Road{
			{ID: "wide-boulevard", Width: 18, Points: []geo.Point{
				{-130, -55}, {-45, -55}, {-45, -5}, {45, -5}, {45, 65}, {130, 65},
			}},
			{ID: "cross-city", Width: 4, Points: []geo.Point{
				{-100, 35}, {-20, 35}, {-20, 90}, {100, 90},
			}},
			{ID: "wide-global", Width: 6, Points: []geo.Point{
				{-10000, 900}, {10000, -900},
			}},
		},
		water: []Area{{
			Kind: "water", Outer: square(-90, -90, 90, 90),
			Holes: [][]geo.Point{square(-50, -50, 50, 50)},
		}},
		areas: []Area{{
			Kind: "parking", Outer: square(-70, 20, 70, 80),
			Holes: [][]geo.Point{square(-30, 35, 30, 65)},
		}},
		green: []Area{{Kind: "forest", Outer: square(-110, -110, 110, 110)}},
		trees: []geo.Point{{-103, -103}, {-91, -103}, {-79, -103}, {0, 0}, {62, 72}},
	}
	got := generateTrees(c, nil, 7000)
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(encoded)
	hash := hex.EncodeToString(sum[:])
	const wantHash = "0d56af3a8d8917bec900bc71198a8af8ae0dc9740a576278c0acad5fd0c1af1e"
	if hash != wantHash {
		t.Fatalf("tree placement hash = %s, want %s (count %d)", hash, wantHash, len(got))
	}
	for _, p := range got {
		if pointInRing(p[0], p[1], c.water[0].Outer) && !pointInRing(p[0], p[1], c.water[0].Holes[0]) {
			t.Errorf("tree %v is in water outside its hole", p)
		}
		if pointInRing(p[0], p[1], c.areas[0].Outer) && !pointInRing(p[0], p[1], c.areas[0].Holes[0]) {
			t.Errorf("tree %v is in paving outside its hole", p)
		}
		for _, r := range c.roads {
			width := r.Width
			if width <= 0 {
				width = 2
			}
			if d, _ := closestOnLine(r.Points, p); d <= width/2+1.5 {
				t.Errorf("tree %v is inside %s clearance (distance %.2f)", p, r.ID, d)
			}
		}
	}
}

func BenchmarkGenerateTreesDense(b *testing.B) {
	const size = 1000
	c := &collected{
		roads: make([]Road, 0, 4000),
		areas: make([]Area, 0, 4000),
		green: []Area{{Kind: "forest", Outer: square(-490, -490, 490, 490)}},
	}
	// Keep many small road and paved-area features near the edge of the city
	// square. Most candidates are far from them, which makes the old full scans
	// representative of a dense response while keeping the benchmark stable.
	for i := 0; i < 4000; i++ {
		x := -480 + float64(i%400)*2.4
		y := 450 + float64(i/400)*3
		c.roads = append(c.roads, Road{
			ID: fmt.Sprintf("road-%d", i), Width: 4,
			Points: []geo.Point{{x, y}, {x + 1, y}},
		})
		c.areas = append(c.areas, Area{
			ID: fmt.Sprintf("area-%d", i), Kind: "parking",
			Outer: square(x-0.5, y-0.5, x+1.5, y+1.5),
		})
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		got := generateTrees(c, nil, size)
		if len(got) == 0 {
			b.Fatal("dense benchmark generated no trees")
		}
	}
}
