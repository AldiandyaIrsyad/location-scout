package osm

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"panelscape/internal/geo"
)

const (
	pad            = 1.2 // features are kept if they touch the square padded by 20%
	simplifyEps    = 1.5 // Douglas-Peucker tolerance (m) for surrounding footprints
	treeRowSpacing = 8   // m between generated trees along tree_row ways
)

var (
	railKinds = []string{"rail", "light_rail", "subway", "tram", "narrow_gauge", "monorail", "funicular"}
	// Green and water kinds, shared with the query builder in query.go.
	greenLeisure = []string{"park", "garden", "playground", "pitch", "recreation_ground", "golf_course", "nature_reserve", "village_green"}
	greenLanduse = []string{"grass", "forest", "meadow", "village_green", "recreation_ground", "flowerbed", "orchard", "vineyard", "cemetery", "allotments", "greenfield"}
	greenNatural = []string{"wood", "scrub", "grassland", "heath"}
)

// roadWidth is the default carriageway width (m) by highway kind.
var roadWidth = map[string]float64{
	"motorway": 14, "trunk": 12, "primary": 11, "secondary": 9, "tertiary": 8,
	"residential": 6, "unclassified": 6, "service": 4, "living_street": 5, "pedestrian": 6,
	"footway": 2, "path": 2, "cycleway": 2, "steps": 2, "track": 3,
}

// Raw Overpass JSON (`out geom`).

type overpassResponse struct {
	Elements []osmElement `json:"elements"`
}

type osmElement struct {
	Type     string      `json:"type"`
	ID       int64       `json:"id"`
	Lat      float64     `json:"lat"`
	Lon      float64     `json:"lon"`
	Tags     tagMap      `json:"tags"`
	Geometry []osmLatLon `json:"geometry"`
	Members  []osmMember `json:"members"`
}

type osmLatLon struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type osmMember struct {
	Type     string      `json:"type"`
	Role     *string     `json:"role"`
	Geometry []osmLatLon `json:"geometry"`
}

// collected holds the usable features of one Overpass response, in local meters.
type collected struct {
	outlines []rawBuilding
	parts    []rawBuilding
	roads    []Road
	railways []Railway
	water    []Area
	green    []Area
	areas    []Area
	trees    []geo.Point
	props    []MappedObject
	barriers []Barrier
	fixtures []Fixture
	areaSeen map[string]bool
	propSeen map[string]bool
}

// Parse turns a raw Overpass JSON response for the size x size square centred on (lat, lon) into
// CityData. It is pure: the same input and seed always give the same output.
func Parse(raw []byte, lat, lon float64, size int, seed int) (*CityData, error) {
	var resp overpassResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, fmt.Errorf("osm: decode overpass response: %w", err)
	}
	half := float64(size) / 2 * pad
	pbox := box{minX: -half, minY: -half, maxX: half, maxY: half}
	c := collect(resp.Elements, lat, lon, pbox)
	sort.SliceStable(c.props, func(i, j int) bool { return c.props[i].ID < c.props[j].ID })

	items := resolveBuildings(c.outlines, c.parts)
	buildings := make([]Building, 0, len(items))
	guessed := 0
	for _, it := range items {
		b := makeBuilding(it, seed)
		if b.Guessed {
			guessed++
		}
		buildings = append(buildings, b)
	}
	mapped := len(c.trees)
	trees := append(c.trees, generateTrees(c, buildings, size)...)

	city := &CityData{
		Center:    LatLon{Lat: lat, Lon: lon},
		Size:      size,
		Seed:      seed,
		Buildings: buildings,
		Roads:     c.roads,
		Railways:  c.railways,
		Water:     c.water,
		Green:     c.green,
		Areas:     c.areas,
		Trees:     trees,
		Props:     c.props,
		Barriers:  c.barriers,
		Fixtures:  c.fixtures,
	}
	city.Viewpoints = FindViewpoints(city)
	city.Stats = Stats{
		Buildings:   len(buildings),
		Guessed:     guessed,
		Roads:       len(c.roads),
		Trees:       len(trees),
		MappedTrees: mapped,
		Bytes:       len(raw),
	}
	return city, nil
}

// ParseSurroundings returns building footprints from the farSize square outside the inner size
// square (judged by centroid), plus mapped context features from at most a 2 km square. Building
// footprints are simplified with Douglas-Peucker; context roads are clipped to the context box.
func ParseSurroundings(raw []byte, lat, lon float64, size, farSize int) (*Surroundings, error) {
	var resp overpassResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, fmt.Errorf("osm: decode overpass response: %w", err)
	}
	half := float64(farSize) / 2 * pad
	pbox := box{minX: -half, minY: -half, maxX: half, maxY: half}
	c := collect(resp.Elements, lat, lon, pbox)
	contextSize := contextSizeFor(farSize)
	contextHalf := float64(contextSize) / 2
	contextBox := box{minX: -contextHalf, minY: -contextHalf, maxX: contextHalf, maxY: contextHalf}

	items := resolveBuildings(c.outlines, c.parts)
	inner := float64(size) / 2
	buildings := make([]Building, 0, len(items))
	for _, it := range items {
		ce := centroid(it.outer)
		if math.Abs(ce[0]) <= inner && math.Abs(ce[1]) <= inner {
			continue
		}
		it.outer = simplifyRing(it.outer, simplifyEps)
		for i, h := range it.holes {
			it.holes[i] = simplifyRing(h, simplifyEps)
		}
		buildings = append(buildings, makeBuilding(it, 0))
	}
	roads, railways := contextLines(c.roads, c.railways, contextBox)
	water := contextAreas(c.water, contextBox)
	green := contextAreas(c.green, contextBox)
	areas := contextAreas(c.areas, contextBox)
	props := contextProps(c.props, contextBox)
	barriers := contextBarriers(c.barriers, contextBox)
	trees := contextTrees(c.trees, contextBox, 4000)
	return &Surroundings{
		Buildings:   buildings,
		Roads:       roads,
		Railways:    railways,
		Water:       water,
		Green:       green,
		Areas:       areas,
		Trees:       trees,
		Props:       props,
		Barriers:    barriers,
		ContextSize: contextSize,
	}, nil
}

// collect walks the element list once and buckets every usable feature.
func collect(elements []osmElement, lat0, lon0 float64, b box) *collected {
	out := &collected{
		outlines: []rawBuilding{}, parts: []rawBuilding{},
		roads: []Road{}, railways: []Railway{},
		water: []Area{}, green: []Area{}, areas: []Area{}, trees: []geo.Point{},
		props: []MappedObject{}, barriers: []Barrier{}, fixtures: []Fixture{},
		areaSeen: map[string]bool{}, propSeen: map[string]bool{},
	}
	toXY := func(g []osmLatLon) []geo.Point {
		pts := make([]geo.Point, len(g))
		for i, p := range g {
			pts[i] = geo.ToLocal(p.Lat, p.Lon, lat0, lon0)
		}
		return pts
	}

	for _, el := range elements {
		tags := el.Tags

		if el.Type == "node" {
			p := geo.ToLocal(el.Lat, el.Lon, lat0, lon0)
			if tags["natural"] == "tree" && b.contains(p) {
				out.trees = append(out.trees, p)
			}
			if propKind(tags) != "" && b.contains(p) {
				addProp(out, mappedObject("n"+strconv.FormatInt(el.ID, 10), tags, p, nil))
			}
			if kind := fixtureKind(tags); kind != "" && b.contains(p) {
				out.fixtures = append(out.fixtures, newFixture("n"+strconv.FormatInt(el.ID, 10), kind, tags, p))
			}
			continue
		}

		if el.Type == "way" {
			if len(el.Geometry) < 2 {
				continue
			}
			closed := isClosedGeom(el.Geometry)
			cat := categorizeWay(tags, closed)
			pts := toXY(el.Geometry)
			id := "w" + strconv.FormatInt(el.ID, 10)
			if cat == "" && propKind(tags) == "" {
				// A barrier line (a closed ring is just a line that returns to its start).
				if kind := barrierKind(tags); kind != "" {
					if line := cleanLine(pts); line != nil && intersectsBox(line, false, b) {
						pieces := clipPolyline(line, b)
						for k, piece := range pieces {
							pid := id
							if len(pieces) > 1 {
								pid = fmt.Sprintf("%s_%d", id, k)
							}
							out.barriers = append(out.barriers, newBarrier(pid, kind, tags, piece))
						}
					}
				}
				continue
			}
			if propKind(tags) != "" && intersectsBox(pts, closed, b) {
				var outer []geo.Point
				if closed {
					outer = cleanRing(pts)
					if outer != nil {
						outer = orient(outer, true)
					}
				}
				position := centroid(pts)
				if outer != nil {
					position = centroid(outer)
				}
				addProp(out, mappedObject(id, tags, position, outer))
			}
			if cat == "" {
				continue
			}

			switch cat {
			case "building", "part":
				ring := cleanRing(pts)
				if ring == nil || !intersectsBox(ring, true, b) {
					continue
				}
				item := rawBuilding{id: id, outer: orient(ring, true), holes: [][]geo.Point{}, tags: tags}
				if cat == "part" {
					out.parts = append(out.parts, item)
				} else {
					out.outlines = append(out.outlines, item)
				}
			case "road":
				line := cleanLine(pts)
				if line == nil || !intersectsBox(line, false, b) {
					continue
				}
				// Long ways are cut to the padded area so geometry stays local.
				pieces := clipPolyline(line, b)
				for k, piece := range pieces {
					pid := id
					if len(pieces) > 1 {
						pid = fmt.Sprintf("%s_%d", id, k)
					}
					out.roads = append(out.roads, makeRoad(pid, tags, piece))
				}
			case "rail":
				line := cleanLine(pts)
				if line == nil || !intersectsBox(line, false, b) {
					continue
				}
				pieces := clipPolyline(line, b)
				for k, piece := range pieces {
					pid := id
					if len(pieces) > 1 {
						pid = fmt.Sprintf("%s_%d", id, k)
					}
					out.railways = append(out.railways, Railway{
						ID: pid, Points: piece, Kind: tags["railway"], Name: tags["name"],
						Bridge: isYes(tags, "bridge"), Tunnel: isYes(tags, "tunnel"), Layer: parseLayer(tags),
					})
				}
			case "treerow":
				line := cleanLine(pts)
				if line == nil {
					continue
				}
				for _, p := range sampleLine(line, treeRowSpacing) {
					if b.contains(p) {
						out.trees = append(out.trees, p)
					}
				}
			default:
				// Closed area features: water, green, plaza, parking.
				ring := cleanRing(pts)
				if ring == nil || !intersectsBox(ring, true, b) {
					continue
				}
				pushArea(out, cat, newArea(id, orient(ring, true), [][]geo.Point{}, cat, tags))
			}
			continue
		}

		if el.Type == "relation" {
			cat := categorizeRelation(tags)
			if cat == "" && propKind(tags) == "" {
				continue
			}
			polys := polysFromMembers(el.Members, lat0, lon0)
			if propKind(tags) != "" {
				for _, poly := range polys {
					if intersectsBox(poly.outer, true, b) {
						addProp(out, mappedObject("r"+strconv.FormatInt(el.ID, 10), tags, centroid(poly.outer), poly.outer))
						break
					}
				}
			}
			if cat == "" {
				continue
			}
			for k, poly := range polys {
				if !intersectsBox(poly.outer, true, b) {
					continue
				}
				id := "r" + strconv.FormatInt(el.ID, 10)
				if len(polys) > 1 {
					id = fmt.Sprintf("r%d_%d", el.ID, k)
				}
				if cat == "building" || cat == "part" {
					item := rawBuilding{id: id, outer: poly.outer, holes: poly.holes, tags: tags}
					if cat == "part" {
						out.parts = append(out.parts, item)
					} else {
						out.outlines = append(out.outlines, item)
					}
				} else {
					pushArea(out, cat, newArea(id, poly.outer, poly.holes, cat, tags))
				}
			}
		}
	}
	return out
}

func isClosedGeom(g []osmLatLon) bool {
	a := g[0]
	z := g[len(g)-1]
	return a.Lat == z.Lat && a.Lon == z.Lon
}

func greenKind(tags tagMap) string {
	if v := tags["leisure"]; v != "" && contains(greenLeisure, v) {
		return v
	}
	if v := tags["landuse"]; v != "" && contains(greenLanduse, v) {
		return v
	}
	if v := tags["natural"]; v != "" && contains(greenNatural, v) {
		return v
	}
	return ""
}

func waterKind(tags tagMap) string {
	if tags["natural"] == "water" {
		return "water"
	}
	if tags["waterway"] == "riverbank" {
		return "riverbank"
	}
	if tags["landuse"] == "reservoir" {
		return "reservoir"
	}
	if tags["amenity"] == "fountain" {
		return "fountain"
	}
	return ""
}

// categorizeWay returns the feature category of a way, or "" when the way is not used.
func categorizeWay(tags tagMap, closed bool) string {
	if bp := tags["building:part"]; bp != "" && bp != "no" {
		return "part"
	}
	if bl := tags["building"]; bl != "" && bl != "no" {
		return "building"
	}
	if hw := tags["highway"]; hw != "" {
		if tags["area"] == "yes" {
			if closed {
				return "plaza"
			}
			return ""
		}
		return "road"
	}
	if rw := tags["railway"]; rw != "" && contains(railKinds, rw) {
		return "rail"
	}
	if waterKind(tags) != "" {
		return "water"
	}
	if greenKind(tags) != "" {
		return "green"
	}
	if tags["place"] == "square" {
		return "plaza"
	}
	if tags["amenity"] == "parking" {
		return "parking"
	}
	if tags["natural"] == "tree_row" {
		return "treerow"
	}
	return ""
}

func categorizeRelation(tags tagMap) string {
	if bp := tags["building:part"]; bp != "" && bp != "no" {
		return "part"
	}
	if bl := tags["building"]; bl != "" && bl != "no" {
		return "building"
	}
	if waterKind(tags) != "" {
		return "water"
	}
	if greenKind(tags) != "" {
		return "green"
	}
	return ""
}

func areaKind(cat string, tags tagMap) string {
	switch cat {
	case "water":
		return waterKind(tags)
	case "green":
		return greenKind(tags)
	case "plaza":
		return "plaza"
	case "parking":
		return "parking"
	}
	return cat
}

func newArea(id string, outer []geo.Point, holes [][]geo.Point, cat string, tags tagMap) Area {
	a := Area{ID: id, Outer: outer, Holes: holes, Kind: areaKind(cat, tags)}
	if a.Kind == "pitch" {
		a.Sport = pitchSport(tags["sport"])
		a.Surface = strings.ToLower(strings.TrimSpace(tags["surface"]))
	}
	return a
}

// pitchSport reduces a sport tag ("basketball", "soccer;futsal") to one sport name. Several different
// sports on one pitch are "multi", because markings for just one of them would be wrong.
func pitchSport(tag string) string {
	sport := ""
	for _, part := range strings.Split(tag, ";") {
		part = strings.ToLower(strings.TrimSpace(part))
		if part == "" || part == sport {
			continue
		}
		if sport != "" {
			return "multi"
		}
		sport = part
	}
	return sport
}

func pushArea(out *collected, cat string, a Area) {
	if a.ID != "" && out.areaSeen[a.ID] {
		return
	}
	if a.ID != "" {
		out.areaSeen[a.ID] = true
	}
	switch cat {
	case "water":
		out.water = append(out.water, a)
	case "green":
		out.green = append(out.green, a)
	default: // plaza, parking
		out.areas = append(out.areas, a)
	}
}

func parseLayer(tags tagMap) int {
	if layer, ok := parseNumber(tags["layer"]); ok {
		return int(math.Trunc(layer))
	}
	return 0
}

func makeRoad(id string, tags tagMap, points []geo.Point) Road {
	kind := tags["highway"]
	width, ok := parseMeters(tags["width"])
	if !ok {
		base := strings.TrimSuffix(kind, "_link")
		w, found := roadWidth[kind]
		if !found {
			w, found = roadWidth[base]
		}
		if !found {
			w = 5
		}
		width = w
	}
	r := Road{
		ID:     id,
		Points: points,
		Kind:   kind,
		Width:  width,
		Name:   tags["name"],
		Bridge: isYes(tags, "bridge"),
		Tunnel: isYes(tags, "tunnel"),
	}
	if lanes, ok := parseNumber(tags["lanes"]); ok {
		r.Lanes = &lanes
	}
	if layer, ok := parseNumber(tags["layer"]); ok {
		r.Layer = int(math.Trunc(layer))
	}
	return r
}

type relPoly struct {
	outer []geo.Point
	holes [][]geo.Point
}

// ll is a [lon, lat] pair, the order osm.js used for relation member geometry.
type ll [2]float64

func llKey(p ll) string {
	return toFixed(p[0], 7) + "," + toFixed(p[1], 7)
}

// polysFromMembers builds multipolygons: outer ways are stitched into rings, inner ways into holes
// assigned to the first outer ring that contains them.
func polysFromMembers(members []osmMember, lat0, lon0 float64) []relPoly {
	var outerSegs, innerSegs [][]ll
	for _, m := range members {
		if m.Type != "way" || len(m.Geometry) < 2 || m.Role == nil {
			continue
		}
		seg := make([]ll, len(m.Geometry))
		for i, g := range m.Geometry {
			seg[i] = ll{g.Lon, g.Lat}
		}
		switch *m.Role {
		case "inner":
			innerSegs = append(innerSegs, seg)
		case "outer", "":
			outerSegs = append(outerSegs, seg)
		}
	}
	toRings := func(rings [][]ll) [][]geo.Point {
		var out [][]geo.Point
		for _, r := range rings {
			pts := make([]geo.Point, len(r))
			for i, p := range r {
				pts[i] = geo.ToLocal(p[1], p[0], lat0, lon0)
			}
			if ring := cleanRing(pts); ring != nil {
				out = append(out, ring)
			}
		}
		return out
	}

	outers := toRings(stitchRings(outerSegs))
	for _, o := range outers {
		orient(o, true)
	}
	inners := toRings(stitchRings(innerSegs))
	for _, h := range inners {
		orient(h, false)
	}

	polys := make([]relPoly, 0, len(outers))
	for _, o := range outers {
		polys = append(polys, relPoly{outer: o, holes: [][]geo.Point{}})
	}
	for _, h := range inners {
		c := h[0]
		for i := range polys {
			if pointInRing(c[0], c[1], polys[i].outer) {
				polys[i].holes = append(polys[i].holes, h)
				break
			}
		}
	}
	return polys
}

// stitchRings joins way segments into rings by matching end points. A closed ring repeats its
// first point at the end. Segments are not reversed unless needed to join them.
func stitchRings(segs [][]ll) [][]ll {
	n := len(segs)
	sk := make([]string, n)
	ek := make([]string, n)
	for i, s := range segs {
		if len(s) >= 2 {
			sk[i] = llKey(s[0])
			ek[i] = llKey(s[len(s)-1])
		}
	}
	used := make([]bool, n)
	var rings [][]ll
	for i := 0; i < n; i++ {
		if used[i] || len(segs[i]) < 2 {
			continue
		}
		used[i] = true
		ring := append([]ll(nil), segs[i]...)
		for {
			head := llKey(ring[0])
			tail := llKey(ring[len(ring)-1])
			if head == tail {
				break
			}
			progressed := false
			for j := 0; j < n; j++ {
				if used[j] || len(segs[j]) < 2 {
					continue
				}
				s := segs[j]
				switch {
				case sk[j] == tail:
					ring = append(ring, s[1:]...)
				case ek[j] == tail:
					ring = append(ring, reversedLL(s[:len(s)-1])...)
				case ek[j] == head:
					ring = append(append([]ll(nil), s[:len(s)-1]...), ring...)
				case sk[j] == head:
					ring = append(reversedLL(s[1:]), ring...)
				default:
					continue
				}
				used[j] = true
				progressed = true
				break
			}
			if !progressed {
				break
			}
		}
		rings = append(rings, ring)
	}
	return rings
}

func reversedLL(s []ll) []ll {
	out := make([]ll, len(s))
	for i, p := range s {
		out[len(s)-1-i] = p
	}
	return out
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}
