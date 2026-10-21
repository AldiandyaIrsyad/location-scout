package osm

import (
	"fmt"
	"strings"
	"testing"

	"panelscape/internal/geo"
)

func TestParseDirection(t *testing.T) {
	cases := []struct {
		in   string
		want float64
		ok   bool
	}{
		{"90", 90, true},
		{"450", 90, true}, // wraps
		{"-90", 270, true},
		{"sw", 225, true}, // compass points, any case
		{" NNE ", 22.5, true},
		{"forward", 0, false}, // OSM relative directions need the way; not usable on a node
		{"10-20", 0, false},
		{"", 0, false},
	}
	for _, c := range cases {
		got, ok := parseDirection(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("parseDirection(%q) = %v, %v; want %v, %v", c.in, got, ok, c.want, c.ok)
		}
	}
}

// metresEast turns an east offset from the test centre into a longitude.
func metresEast(m float64) float64 { return testLon + m/(111320*0.8118) } // cos(35.6595 deg)
func metresNorth(m float64) float64 { return testLat + m/110574 }

func nodeJSON(id int, east, north float64, tags string) string {
	return fmt.Sprintf(`{"type":"node","id":%d,"lat":%f,"lon":%f,"tags":{%s}}`, id, metresNorth(north), metresEast(east), tags)
}

func wayJSON(id int, tags string, pts ...[2]float64) string {
	geometry := make([]string, len(pts))
	for i, p := range pts {
		geometry[i] = fmt.Sprintf(`{"lat":%f,"lon":%f}`, metresNorth(p[1]), metresEast(p[0]))
	}
	return fmt.Sprintf(`{"type":"way","id":%d,"tags":{%s},"geometry":[%s]}`, id, tags, strings.Join(geometry, ","))
}

func TestBarriersAndFixturesAreCollectedByKind(t *testing.T) {
	raw := []byte(`{"elements":[` + strings.Join([]string{
		wayJSON(1, `"barrier":"fence","height":"2.4 m"`, [2]float64{-50, 0}, [2]float64{50, 0}),
		wayJSON(2, `"barrier":"hedge"`, [2]float64{-50, 20}, [2]float64{50, 20}),
		wayJSON(3, `"barrier":"kerb"`, [2]float64{-50, 40}, [2]float64{50, 40}),
		wayJSON(4, `"barrier":"gate"`, [2]float64{-50, 60}, [2]float64{50, 60}),
		// a long wall running far beyond the padded area is cut to it
		wayJSON(5, `"barrier":"wall"`, [2]float64{-5000, 80}, [2]float64{5000, 80}),
		// a building that is also tagged as a wall stays a building, not a barrier
		wayJSON(6, `"building":"yes","barrier":"wall"`, [2]float64{-20, -50}, [2]float64{-10, -50}, [2]float64{-10, -40}, [2]float64{-20, -40}, [2]float64{-20, -50}),
		nodeJSON(10, 10, 10, `"amenity":"bench","direction":"SW"`),
		nodeJSON(11, 12, 10, `"amenity":"bench","direction":"forward"`),
		nodeJSON(12, 14, 10, `"amenity":"waste_basket"`),
		nodeJSON(13, 16, 10, `"highway":"bus_stop","shelter":"yes"`),
		nodeJSON(14, 18, 10, `"highway":"bus_stop"`),
		nodeJSON(15, 5000, 10, `"amenity":"bench"`), // far outside the area
		nodeJSON(16, 20, 10, `"amenity":"cafe"`),
	}, ",") + `]}`)
	city, err := Parse(raw, testLat, testLon, testSize, 0)
	if err != nil {
		t.Fatal(err)
	}

	kinds := map[string]Barrier{}
	for _, b := range city.Barriers {
		kinds[b.Kind] = b
	}
	if len(city.Barriers) != 3 || kinds["fence"].ID == "" || kinds["hedge"].ID == "" || kinds["wall"].ID == "" {
		t.Fatalf("barriers = %+v, want one fence, hedge and wall (no kerb, gate or building)", city.Barriers)
	}
	if kinds["fence"].Height != 2.4 || kinds["hedge"].Height != 0 {
		t.Errorf("heights fence=%v hedge=%v, want 2.4 and 0 (untagged)", kinds["fence"].Height, kinds["hedge"].Height)
	}
	wall := kinds["wall"]
	for _, p := range wall.Points {
		if p[0] < -300 || p[0] > 300 {
			t.Fatalf("wall point %v is outside the padded area; the long way must be clipped", p)
		}
	}
	if len(city.Buildings) != 1 {
		t.Errorf("buildings = %d, want the wall-tagged building kept as one", len(city.Buildings))
	}

	got := map[string][]Fixture{}
	for _, f := range city.Fixtures {
		got[f.Kind] = append(got[f.Kind], f)
	}
	if len(got["bench"]) != 2 || len(got["waste_basket"]) != 1 || len(got["bus_stop"]) != 2 || len(city.Fixtures) != 5 {
		t.Fatalf("fixtures = %+v, want 2 benches, 1 basket, 2 bus stops (not the far bench or the cafe)", city.Fixtures)
	}
	var facing, unknown int
	for _, b := range got["bench"] {
		if b.Direction != nil && *b.Direction == 225 {
			facing++
		}
		if b.Direction == nil {
			unknown++
		}
	}
	if facing != 1 || unknown != 1 {
		t.Errorf("bench directions: %d facing SW, %d unknown; want 1 and 1", facing, unknown)
	}
	sheltered := 0
	for _, s := range got["bus_stop"] {
		if s.Shelter {
			sheltered++
		}
	}
	if sheltered != 1 {
		t.Errorf("sheltered bus stops = %d, want 1", sheltered)
	}
	if got["bench"][0].Shelter || got["waste_basket"][0].Shelter {
		t.Error("shelter only applies to bus stops")
	}
}

func TestSurroundingsKeepBarriersButNotFurniture(t *testing.T) {
	raw := []byte(`{"elements":[` + strings.Join([]string{
		wayJSON(1, `"barrier":"fence"`, [2]float64{-900, 700}, [2]float64{900, 700}),
		wayJSON(2, `"barrier":"fence"`, [2]float64{-900, 1400}, [2]float64{900, 1400}), // beyond the 2 km context box
		nodeJSON(10, 10, 10, `"amenity":"bench"`),
	}, ",") + `]}`)
	sur, err := ParseSurroundings(raw, testLat, testLon, testSize, 2000)
	if err != nil {
		t.Fatal(err)
	}
	if len(sur.Barriers) != 1 || sur.Barriers[0].Points[0][1] < 600 {
		t.Fatalf("context barriers = %+v, want only the fence inside the 2 km context box", sur.Barriers)
	}
}

func TestContextBarriersKeepTheNearestUnderTheCap(t *testing.T) {
	const extra = 40
	var all []Barrier
	for i := 0; i < maxContextBarriers+extra; i++ {
		// pieces run outward along x: piece i starts i metres from the centre
		x := float64(i)
		all = append(all, Barrier{ID: fmt.Sprintf("w%d", i), Kind: "fence", Points: []geo.Point{{x, 0}, {x + 1, 0}}})
	}
	out := contextBarriers(all, box{minX: -3000, minY: -3000, maxX: 3000, maxY: 3000})
	if len(out) != maxContextBarriers {
		t.Fatalf("kept %d, want the cap %d", len(out), maxContextBarriers)
	}
	for _, b := range out {
		if b.Points[0][0] >= float64(maxContextBarriers) {
			t.Fatalf("kept %s at %v, but nearer pieces were dropped", b.ID, b.Points[0])
		}
	}
}
