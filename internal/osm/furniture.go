package osm

import (
	"sort"
	"strconv"
	"strings"

	"panelscape/internal/geo"
)

// barrierKinds are the line barriers the renderer draws. Gates and kerbs are left out on purpose:
// a gate is an opening, and the renderer already leaves a gap wherever a road crosses a barrier.
var barrierKinds = []string{"fence", "wall", "retaining_wall", "city_wall", "hedge", "jersey_barrier", "handrail", "guard_rail"}

// maxContextBarriers bounds the barrier pieces sent for the surroundings; the nearest are kept.
const maxContextBarriers = 2500

func barrierKind(tags tagMap) string {
	if contains(barrierKinds, tags["barrier"]) {
		return tags["barrier"]
	}
	return ""
}

// fixtureKind maps mapped street furniture nodes to the kinds the renderer draws.
func fixtureKind(tags tagMap) string {
	switch {
	case tags["amenity"] == "bench":
		return "bench"
	case tags["amenity"] == "waste_basket":
		return "waste_basket"
	case tags["highway"] == "bus_stop":
		return "bus_stop"
	}
	return ""
}

var compass = map[string]float64{
	"N": 0, "NNE": 22.5, "NE": 45, "ENE": 67.5, "E": 90, "ESE": 112.5, "SE": 135, "SSE": 157.5,
	"S": 180, "SSW": 202.5, "SW": 225, "WSW": 247.5, "W": 270, "WNW": 292.5, "NW": 315, "NNW": 337.5,
}

// parseDirection reads a direction tag as compass degrees in [0, 360): a number or a compass point.
// Anything else, including OSM's "forward"/"backward" and ranges, is not usable.
func parseDirection(v string) (float64, bool) {
	v = strings.TrimSpace(v)
	if deg, ok := compass[strings.ToUpper(v)]; ok {
		return deg, true
	}
	deg, err := strconv.ParseFloat(v, 64)
	if err != nil || deg != deg {
		return 0, false
	}
	deg = deg - 360*float64(int(deg/360))
	if deg < 0 {
		deg += 360
	}
	return deg, true
}

func newFixture(id, kind string, tags tagMap, p geo.Point) Fixture {
	f := Fixture{ID: id, Kind: kind, Position: p}
	if deg, ok := parseDirection(tags["direction"]); ok {
		f.Direction = &deg
	}
	if kind == "bus_stop" {
		f.Shelter = isYes(tags, "shelter")
	}
	return f
}

func newBarrier(id, kind string, tags tagMap, piece []geo.Point) Barrier {
	b := Barrier{ID: id, Points: piece, Kind: kind}
	if h, ok := parseMeters(tags["height"]); ok && h > 0 {
		b.Height = h
	}
	return b
}

// contextBarriers clips barriers to the context box and keeps the maxContextBarriers nearest pieces.
func contextBarriers(barriers []Barrier, b box) []Barrier {
	out := make([]Barrier, 0, len(barriers))
	seen := map[string]bool{}
	for _, bar := range barriers {
		clipPieces(bar.ID, bar.Points, b, seen, func(id string, piece []geo.Point) {
			item := bar
			item.ID, item.Points = id, piece
			out = append(out, item)
		})
	}
	nearest := func(p []geo.Point) float64 {
		d := -1.0
		for _, q := range p {
			if m := q[0]*q[0] + q[1]*q[1]; d < 0 || m < d {
				d = m
			}
		}
		return d
	}
	sort.SliceStable(out, func(i, j int) bool {
		di, dj := nearest(out[i].Points), nearest(out[j].Points)
		if di != dj {
			return di < dj
		}
		return out[i].ID < out[j].ID
	})
	if len(out) > maxContextBarriers {
		out = out[:maxContextBarriers]
	}
	return out
}
