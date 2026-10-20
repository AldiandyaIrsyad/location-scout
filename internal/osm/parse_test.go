package osm

import (
	"encoding/json"
	"math"
	"os"
	"strings"
	"testing"

	"panelscape/internal/geo"
)

// The fixture is centred on this point and built for a 400 m square (padded square: 480 m).
const (
	testLat  = 35.6595
	testLon  = 139.7005
	testSize = 400
)

func loadSample(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/sample.json")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func parseSample(t *testing.T, seed int) *CityData {
	t.Helper()
	city, err := Parse(loadSample(t), testLat, testLon, testSize, seed)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return city
}

func buildingByID(c *CityData, id string) *Building {
	for i := range c.Buildings {
		if c.Buildings[i].ID == id {
			return &c.Buildings[i]
		}
	}
	return nil
}

func near(a, b, tol float64) bool { return math.Abs(a-b) <= tol }

func TestParseCounts(t *testing.T) {
	raw := loadSample(t)
	c, err := Parse(raw, testLat, testLon, testSize, 0)
	if err != nil {
		t.Fatal(err)
	}

	ids := map[string]bool{}
	for _, b := range c.Buildings {
		ids[b.ID] = true
	}
	if len(c.Buildings) != 6 {
		t.Fatalf("buildings = %d, want 6 (got ids %v)", len(c.Buildings), ids)
	}
	for _, want := range []string{"w1001", "w1002", "w1003", "w1005", "w1006", "r2001"} {
		if !ids[want] {
			t.Errorf("missing building %s", want)
		}
	}
	if ids["w1004"] {
		t.Error("outline w1004 should be dropped: its building:parts cover it")
	}
	if ids["w1009"] || ids["w1010"] {
		t.Error("buildings outside the padded square must not be in the city")
	}

	names := map[string]bool{}
	for _, r := range c.Roads {
		names[r.Name] = true
	}
	for _, want := range []string{"Main Street", "Second Avenue", "Side Lane"} {
		if !names[want] {
			t.Errorf("missing road %q", want)
		}
	}
	if len(c.Roads) != 3 {
		t.Errorf("roads = %d, want 3", len(c.Roads))
	}
	if len(c.Railways) != 1 {
		t.Errorf("railways = %d, want 1", len(c.Railways))
	}
	if len(c.Water) != 1 || c.Water[0].Kind != "water" {
		t.Errorf("water = %+v, want one water area", c.Water)
	}
	if len(c.Green) != 1 || c.Green[0].Kind != "park" {
		t.Errorf("green = %+v, want one park", c.Green)
	}
	if len(c.Areas) != 1 || c.Areas[0].Kind != "parking" {
		t.Errorf("areas = %+v, want one parking area", c.Areas)
	}

	// Mapped trees: the natural=tree node inside the square plus 8 samples on the 60 m tree_row
	// (every 8 m, from its start). The node at 500 m is outside.
	st := c.Stats
	if st.Buildings != 6 || st.Guessed != 2 || st.Roads != 3 || st.MappedTrees != 9 {
		t.Errorf("stats = %+v, want buildings 6, guessed 2, roads 3, mappedTrees 9", st)
	}
	if st.Trees != len(c.Trees) {
		t.Errorf("stats.trees = %d, len(trees) = %d", st.Trees, len(c.Trees))
	}
	if st.Bytes != len(raw) {
		t.Errorf("stats.bytes = %d, want raw length %d", st.Bytes, len(raw))
	}
	if c.Center.Lat != testLat || c.Center.Lon != testLon || c.Size != testSize {
		t.Errorf("center/size = %+v %d", c.Center, c.Size)
	}
}

func TestRingWinding(t *testing.T) {
	c := parseSample(t, 0)
	for _, b := range c.Buildings {
		if polyArea(b.Outer) <= 0 {
			t.Errorf("building %s outer ring is not counter-clockwise", b.ID)
		}
		for _, h := range b.Holes {
			if polyArea(h) >= 0 {
				t.Errorf("building %s hole is not clockwise", b.ID)
			}
		}
	}
	for _, a := range append(append(append([]Area{}, c.Water...), c.Green...), c.Areas...) {
		if polyArea(a.Outer) <= 0 {
			t.Errorf("area %s outer ring is not counter-clockwise", a.Kind)
		}
	}
	rel := buildingByID(c, "r2001")
	if rel == nil {
		t.Fatal("relation building r2001 missing")
	}
	if len(rel.Holes) != 1 {
		t.Fatalf("r2001 holes = %d, want 1", len(rel.Holes))
	}
	if len(rel.Outer) != 4 {
		t.Errorf("r2001 outer has %d vertices, want 4 (stitched from two ways)", len(rel.Outer))
	}
	if n := len(buildingByID(c, "w1001").Holes); n != 0 {
		t.Errorf("w1001 holes = %d, want 0", n)
	}
}

func TestClippedRoadsWithinBox(t *testing.T) {
	c := parseSample(t, 0)
	const limit = 200 * 1.2 // the 400 m square padded by 20%
	for _, r := range c.Roads {
		for _, p := range r.Points {
			if math.Abs(p[0]) > limit+1e-6 || math.Abs(p[1]) > limit+1e-6 {
				t.Errorf("road %s point %v lies outside the padded box", r.ID, p)
			}
		}
	}
	for _, rw := range c.Railways {
		for _, p := range rw.Points {
			if math.Abs(p[0]) > limit+1e-6 || math.Abs(p[1]) > limit+1e-6 {
				t.Errorf("railway %s point %v lies outside the padded box", rw.ID, p)
			}
		}
	}
	// Main Street runs 1000 m each way; after clipping its first vertex is on the west edge.
	for _, r := range c.Roads {
		if r.Name != "Main Street" {
			continue
		}
		if !near(r.Points[0][0], -limit, 1e-6) {
			t.Errorf("Main Street starts at %v, want x = -%v (clipped)", r.Points[0], limit)
		}
	}
}

func TestHeights(t *testing.T) {
	c := parseSample(t, 0)

	if b := buildingByID(c, "w1001"); b == nil || b.Height != 30 || b.Guessed || b.Levels != nil {
		t.Errorf("w1001 (height tag) = %+v, want height 30, not guessed, no levels", b)
	}
	if b := buildingByID(c, "w1002"); b == nil || b.Height != 16 || b.Guessed || b.Levels == nil || *b.Levels != 5 {
		t.Errorf("w1002 (levels) = %+v, want height 5*3.2 = 16, levels 5", b)
	}
	if b := buildingByID(c, "w1003"); b == nil || !b.Guessed || b.Height < 6 || b.Height > 9 || b.Height*2 != math.Round(b.Height*2) {
		t.Errorf("w1003 (guessed house) = %+v, want a guessed half-metre height in [6, 9]", b)
	}
	if b := buildingByID(c, "w1005"); b == nil || b.Height != 12 {
		t.Errorf("building:part w1005 height = %+v, want 12", b)
	}
	if b := buildingByID(c, "w1006"); b == nil || b.Height != 9 {
		t.Errorf("building:part w1006 height = %+v, want 9", b)
	}
	if b := buildingByID(c, "r2001"); b == nil || !b.Guessed || b.Height < 15 || b.Height > 25 {
		t.Errorf("relation r2001 = %+v, want a guessed height in [15, 25]", b)
	}
}

// Expected heights come from running web/js/osm.js (rerollHeights) on the same fixture.
func TestSeedRerollsGuessedHeights(t *testing.T) {
	want := map[int]map[string]float64{
		0: {"w1003": 6.5, "r2001": 17.5},
		1: {"w1003": 7.5, "r2001": 15},
		7: {"w1003": 8, "r2001": 16.5},
	}
	for seed, heights := range want {
		c := parseSample(t, seed)
		for id, h := range heights {
			b := buildingByID(c, id)
			if b == nil {
				t.Errorf("seed %d: building %s missing", seed, id)
			} else if b.Height != h {
				t.Errorf("seed %d: %s height = %v, want %v", seed, id, b.Height, h)
			}
		}
		if c.Seed != seed {
			t.Errorf("Seed = %d, want %d", c.Seed, seed)
		}
	}

	// Only guessed heights move with the seed.
	a := parseSample(t, 0)
	b := parseSample(t, 7)
	for i := range a.Buildings {
		ba, bb := a.Buildings[i], buildingByID(b, a.Buildings[i].ID)
		if !ba.Guessed && ba.Height != bb.Height {
			t.Errorf("%s is not guessed but its height changed with seed: %v -> %v", ba.ID, ba.Height, bb.Height)
		}
	}

	// The same seed is deterministic.
	j1, _ := json.Marshal(parseSample(t, 3))
	j2, _ := json.Marshal(parseSample(t, 3))
	if string(j1) != string(j2) {
		t.Error("Parse is not deterministic for a fixed seed")
	}
}

func TestPRNGMatchesJS(t *testing.T) {
	if h := hashString("w1003|0"); h != 2945078278 {
		t.Errorf("hashString = %d, want 2945078278", h)
	}
	r := mulberry32(hashString("w1003|0"))
	want := []float64{0.17020868207328022, 0.6573780768085271, 0.4594807515386492}
	for i, w := range want {
		if got := r(); got != w {
			t.Errorf("mulberry32 draw %d = %v, want %v", i, got, w)
		}
	}
}

func TestToFixedMatchesJS(t *testing.T) {
	cases := []struct {
		x    float64
		d    int
		want string
	}{
		{2.25, 1, "2.3"},
		{-2.25, 1, "-2.3"},
		{0.25, 1, "0.3"},
		{1.005, 2, "1.00"},
		{0.5, 0, "1"},
		{2.5, 0, "3"},
		{-2.5, 0, "-3"},
		{-0.04, 1, "-0.0"},
		{0, 1, "0.0"},
		{123.456, 2, "123.46"},
		{-1234.5678, 2, "-1234.57"},
		{1e-7, 7, "0.0000001"},
		{35.6595, 7, "35.6595000"},
	}
	for _, c := range cases {
		if got := toFixed(c.x, c.d); got != c.want {
			t.Errorf("toFixed(%v, %d) = %q, want %q", c.x, c.d, got, c.want)
		}
	}
}

func TestGeneratedTrees(t *testing.T) {
	c := parseSample(t, 0)
	if c.Stats.Trees <= c.Stats.MappedTrees {
		t.Errorf("trees = %d, want more than the %d mapped", c.Stats.Trees, c.Stats.MappedTrees)
	}
	// 297 is the count osm.js produces for this fixture.
	if len(c.Trees) != 297 {
		t.Errorf("trees = %d, want 297 (osm.js output for this fixture)", len(c.Trees))
	}
	half := float64(testSize) / 2
	for _, p := range c.Trees {
		if math.Abs(p[0]) > half+1e-9 || math.Abs(p[1]) > half+1e-9 {
			t.Fatalf("tree %v outside the city square", p)
		}
	}
}

func TestViewpoints(t *testing.T) {
	c := parseSample(t, 0)

	var crossings, eye, low, down []Viewpoint
	for _, v := range c.Viewpoints {
		switch v.Kind {
		case "crossing":
			crossings = append(crossings, v)
		case "street-eye":
			eye = append(eye, v)
		case "street-low":
			low = append(low, v)
		case "street-down":
			down = append(down, v)
		}
	}
	if len(crossings) != 1 {
		t.Fatalf("crossings = %d, want 1", len(crossings))
	}
	cr := crossings[0]
	if cr.Label != "Crossing 1 Main Street × Second Avenue" {
		t.Errorf("crossing label = %q", cr.Label)
	}
	if cr.EyeHeight != 1.6 || cr.Target != (geo.Point{0, 0}) {
		t.Errorf("crossing = %+v, want eye height 1.6 looking at the intersection", cr)
	}
	// Stand 28 m back along Main Street and 7 m onto the sidewalk.
	if !near(cr.Position[0], -28, 1e-6) || !near(cr.Position[1], -7, 1e-6) {
		t.Errorf("crossing position = %v, want (-28, -7)", cr.Position)
	}

	if len(eye) != 1 || len(low) != 1 || len(down) != 1 {
		t.Fatalf("central street views = %d/%d/%d, want 1 each", len(eye), len(low), len(down))
	}
	if len(c.Viewpoints) != 4 {
		t.Errorf("viewpoints = %d, want 4", len(c.Viewpoints))
	}
	for _, v := range []Viewpoint{eye[0], low[0], down[0]} {
		if !strings.Contains(v.Label, "Main Street") {
			t.Errorf("central street label %q should name Main Street (the widest major street)", v.Label)
		}
		if v.Position != eye[0].Position || v.Target != eye[0].Target {
			t.Errorf("central street views should share one camera: %+v vs %+v", v, eye[0])
		}
	}
	if eye[0].EyeHeight != 1.6 || low[0].EyeHeight != 0.4 || down[0].EyeHeight != 25 {
		t.Errorf("eye heights = %v/%v/%v, want 1.6/0.4/25", eye[0].EyeHeight, low[0].EyeHeight, down[0].EyeHeight)
	}
}

func TestSurroundingsExcludeInnerBuildings(t *testing.T) {
	sur, err := ParseSurroundings(loadSample(t), testLat, testLon, testSize, 800)
	if err != nil {
		t.Fatal(err)
	}
	if len(sur.Buildings) != 1 || sur.Buildings[0].ID != "w1010" {
		t.Fatalf("surroundings = %+v, want only w1010", sur.Buildings)
	}
	for _, b := range sur.Buildings {
		c := centroid(b.Outer)
		if math.Abs(c[0]) <= testSize/2 && math.Abs(c[1]) <= testSize/2 {
			t.Errorf("building %s centroid %v lies inside the inner square", b.ID, c)
		}
		if len(b.Outer) < 3 {
			t.Errorf("building %s simplified to %d vertices", b.ID, len(b.Outer))
		}
	}
	if b := sur.Buildings[0]; b.Levels == nil || *b.Levels != 3 || !near(b.Height, 9.6, 1e-9) {
		t.Errorf("w1010 = %+v, want 3 levels and height 9.6", b)
	}
}

func TestDouglasPeuckerKeepsCorners(t *testing.T) {
	ring := []geo.Point{{0, 0}, {5, 0.2}, {10, 0}, {10, 10}, {0, 10}}
	got := simplifyRing(ring, 1.5)
	if len(got) != 4 {
		t.Fatalf("simplifyRing kept %d vertices, want the 4 corners: %v", len(got), got)
	}
}

func TestJSONSlicesNeverNull(t *testing.T) {
	check := func(t *testing.T, raw []byte) {
		t.Helper()
		var top map[string]json.RawMessage
		if err := json.Unmarshal(raw, &top); err != nil {
			t.Fatal(err)
		}
		for _, k := range []string{"buildings", "roads", "railways", "water", "green", "areas", "trees", "viewpoints"} {
			v, ok := top[k]
			if !ok || string(v) == "null" || !strings.HasPrefix(string(v), "[") {
				t.Errorf("%s = %s, want a JSON array", k, v)
			}
		}
		var blds []map[string]json.RawMessage
		if err := json.Unmarshal(top["buildings"], &blds); err != nil {
			t.Fatal(err)
		}
		for _, b := range blds {
			if h := string(b["holes"]); !strings.HasPrefix(h, "[") {
				t.Errorf("building holes = %s, want []", h)
			}
		}
	}

	c := parseSample(t, 0)
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	check(t, raw)

	empty, err := Parse([]byte(`{"elements":[]}`), testLat, testLon, testSize, 0)
	if err != nil {
		t.Fatal(err)
	}
	raw, err = json.Marshal(empty)
	if err != nil {
		t.Fatal(err)
	}
	check(t, raw)

	sur, err := ParseSurroundings([]byte(`{"elements":[]}`), testLat, testLon, testSize, 800)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = json.Marshal(sur)
	if string(raw) != `{"buildings":[]}` {
		t.Errorf("empty surroundings = %s", raw)
	}
}

func TestParseRejectsInvalidJSON(t *testing.T) {
	if _, err := Parse([]byte("not json"), testLat, testLon, testSize, 0); err == nil {
		t.Error("Parse accepted invalid JSON")
	}
	if _, err := ParseSurroundings([]byte("{"), testLat, testLon, testSize, 800); err == nil {
		t.Error("ParseSurroundings accepted invalid JSON")
	}
}
