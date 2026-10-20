package osm

import (
	"sort"
	"strconv"

	"panelscape/internal/geo"
)

// propKind maps the small set of landmark tags that the renderer can represent. OSM uses both
// tourism=artwork and historic=* for statues and memorials, so the explicit historic value wins.
func propKind(tags tagMap) string {
	switch tags["historic"] {
	case "memorial":
		if tags["memorial"] == "statue" {
			return "statue"
		}
		return "memorial"
	case "monument":
		if tags["monument"] == "statue" {
			return "statue"
		}
		return "monument"
	}
	if tags["tourism"] == "artwork" {
		switch tags["artwork_type"] {
		case "statue", "sculpture":
			return "statue"
		}
	}
	if tags["amenity"] == "fountain" {
		return "fountain"
	}
	return ""
}

// mappedHeight keeps a tagged height exactly when it is usable. Untagged props get conservative,
// bounded heights so a missing OSM value cannot produce either an invisible object or a giant one.
func mappedHeight(kind string, tags tagMap) (float64, bool) {
	for _, key := range []string{"height", "artwork:height", "memorial:height", "monument:height", "fountain:height"} {
		if h, ok := parseMeters(tags[key]); ok && h > 0 {
			return h, false
		}
	}
	defaults := map[string]float64{
		"statue":   4,
		"monument": 8,
		"memorial": 5,
		"fountain": 1.5,
	}
	h, ok := defaults[kind]
	if !ok {
		h = 4
	}
	return h, true
}

func mappedObject(id string, tags tagMap, position geo.Point, outer []geo.Point) MappedObject {
	kind := propKind(tags)
	height, guessed := mappedHeight(kind, tags)
	m := MappedObject{
		ID:       id,
		Name:     tags["name"],
		Kind:     kind,
		Position: position,
		Height:   height,
		Guessed:  guessed,
		Outer:    outer,
	}
	for _, key := range []string{"material", "statue:material", "artwork:material", "memorial:material"} {
		if tags[key] != "" {
			m.Material = tags[key]
			break
		}
	}
	return m
}

func addProp(c *collected, p MappedObject) {
	if p.Kind == "" || p.ID == "" || c.propSeen[p.ID] {
		return
	}
	c.propSeen[p.ID] = true
	c.props = append(c.props, p)
}

// maxContextSize is the side of the square, in metres, that mapped context features are fetched for.
const maxContextSize = 2000

// contextSizeFor is the side of the mapped-context square for a requested far size.
func contextSizeFor(farSize int) int {
	return max(0, min(farSize, maxContextSize))
}

// clipPieces clips points to the context box and calls emit once per piece. Pieces of a way that
// is split get a numbered suffix on its id; ids already emitted through seen are skipped.
func clipPieces(id string, points []geo.Point, b box, seen map[string]bool, emit func(id string, piece []geo.Point)) {
	if !intersectsBox(points, false, b) {
		return
	}
	pieces := clipPolyline(points, b)
	for i, piece := range pieces {
		pid := id
		if len(pieces) > 1 {
			pid += "_" + strconv.Itoa(i)
		}
		if seen[pid] {
			continue
		}
		seen[pid] = true
		emit(pid, piece)
	}
}

// contextLines clips roads and railways to the smaller surroundings context box. Clipping keeps
// large far-side ways from inflating the JSON while retaining their bridge/tunnel/layer metadata.
func contextLines(roads []Road, railways []Railway, b box) ([]Road, []Railway) {
	outRoads := make([]Road, 0, len(roads))
	roadIDs := map[string]bool{}
	for _, r := range roads {
		clipPieces(r.ID, r.Points, b, roadIDs, func(id string, piece []geo.Point) {
			item := r
			item.ID, item.Points = id, piece
			outRoads = append(outRoads, item)
		})
	}
	outRailways := make([]Railway, 0, len(railways))
	railIDs := map[string]bool{}
	for _, r := range railways {
		clipPieces(r.ID, r.Points, b, railIDs, func(id string, piece []geo.Point) {
			item := r
			item.ID, item.Points = id, piece
			outRailways = append(outRailways, item)
		})
	}
	return outRoads, outRailways
}

func contextAreas(areas []Area, b box) []Area {
	out := make([]Area, 0, len(areas))
	seen := map[string]bool{}
	for _, a := range areas {
		if !intersectsBox(a.Outer, true, b) {
			continue
		}
		if a.ID != "" && seen[a.ID] {
			continue
		}
		if a.ID != "" {
			seen[a.ID] = true
		}
		out = append(out, a)
	}
	return out
}

func contextProps(props []MappedObject, b box) []MappedObject {
	out := make([]MappedObject, 0, len(props))
	for _, p := range props {
		if b.contains(p.Position) {
			out = append(out, p)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func contextTrees(trees []geo.Point, b box, limit int) []geo.Point {
	out := make([]geo.Point, 0, len(trees))
	for _, p := range trees {
		if b.contains(p) {
			out = append(out, p)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		di := out[i][0]*out[i][0] + out[i][1]*out[i][1]
		dj := out[j][0]*out[j][0] + out[j][1]*out[j][1]
		if di != dj {
			return di < dj
		}
		if out[i][0] != out[j][0] {
			return out[i][0] < out[j][0]
		}
		return out[i][1] < out[j][1]
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}
