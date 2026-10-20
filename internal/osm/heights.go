package osm

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"

	"panelscape/internal/geo"
)

// tagMap holds the OSM tags of an element. A missing key reads as "" (the JS code treated
// missing and empty tags alike in most places).
type tagMap map[string]string

// rawBuilding is a building or building:part outline before heights are resolved.
type rawBuilding struct {
	id    string
	outer []geo.Point
	holes [][]geo.Point
	tags  tagMap
}

// Height guesses by building kind: [min, max] meters, sampled with a seeded PRNG.
var kindHeights = map[string][2]float64{
	"house": {6, 9}, "detached": {6, 9}, "semidetached_house": {6, 9}, "terrace": {7, 10}, "bungalow": {4, 6},
	"residential": {12, 25}, "apartments": {12, 25}, "dormitory": {14, 25},
	"commercial": {10, 30}, "retail": {8, 20}, "office": {12, 40}, "hotel": {15, 30},
	"industrial": {8, 10}, "warehouse": {8, 12},
	"garage": {3, 3.5}, "garages": {3, 3.5}, "shed": {2.5, 3.5}, "roof": {2.5, 3.5},
	"temple": {7, 9}, "shrine": {7, 9}, "church": {12, 20}, "cathedral": {18, 30},
	"school": {12, 16}, "university": {14, 25}, "hospital": {18, 30}, "civic": {10, 20},
}

var (
	numberRe = regexp.MustCompile(`-?\d+(?:[.,]\d+)?`)
	meterRe  = regexp.MustCompile(`^(-?\d+(?:[.,]\d+)?)\s*(m|meters?|metres?|ft|feet|'|′)?`)
)

// parseNumber returns the first number in a tag value such as "3", "3.5" or "3,5".
func parseNumber(v string) (float64, bool) {
	m := numberRe.FindString(v)
	if m == "" {
		return 0, false
	}
	n, err := strconv.ParseFloat(strings.Replace(m, ",", ".", 1), 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

// parseMeters returns meters from a tag value such as "12", "12 m", "40 ft" or "3,5".
func parseMeters(v string) (float64, bool) {
	s := strings.ToLower(strings.TrimSpace(v))
	m := meterRe.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	n, err := strconv.ParseFloat(strings.Replace(m[1], ",", ".", 1), 64)
	if err != nil || math.IsInf(n, 0) || math.IsNaN(n) {
		return 0, false
	}
	switch m[2] {
	case "", "m", "meter", "meters", "metre", "metres":
	default:
		n *= 0.3048
	}
	return n, true
}

// isYes mirrors osm.js isYes: the tag is present and not "no".
func isYes(t tagMap, k string) bool {
	v, ok := t[k]
	return ok && v != "no"
}

// hashString is FNV-1a 32-bit over UTF-16 code units, as the JS version hashed charCodeAt values.
func hashString(s string) uint32 {
	h := uint32(0x811c9dc5)
	mix := func(c uint16) {
		h ^= uint32(c)
		h *= 0x01000193
	}
	for _, r := range s {
		if r >= 0x10000 {
			r1, r2 := utf16.EncodeRune(r)
			mix(uint16(r1))
			mix(uint16(r2))
		} else {
			mix(uint16(r))
		}
	}
	return h
}

// mulberry32 is a small deterministic PRNG returning floats in [0, 1). It reproduces the JS
// implementation bit for bit (32-bit wrapping arithmetic throughout).
func mulberry32(seed uint32) func() float64 {
	a := seed
	return func() float64 {
		a += 0x6d2b79f5
		t := (a ^ (a >> 15)) * (1 | a)
		t = (t + (t^(t>>7))*(61|t)) ^ t
		return float64(t^(t>>14)) / 4294967296
	}
}

func guessHeight(kind string, area float64, rng func() float64) float64 {
	r, ok := kindHeights[kind]
	if !ok {
		switch {
		case area < 80:
			r = [2]float64{6, 9}
		case area < 250:
			r = [2]float64{9, 14}
		case area < 600:
			r = [2]float64{12, 20}
		default:
			r = [2]float64{15, 25}
		}
	}
	h := r[0] + rng()*(r[1]-r[0])
	return math.Floor(h*2+0.5) / 2 // half-meter steps, like JS Math.round(h * 2) / 2
}

// heightSeed is the PRNG seed for a building's guessed height.
func heightSeed(id string, seed int) uint32 {
	return hashString(fmt.Sprintf("%s|%d", id, seed))
}

// makeBuilding turns a resolved outline into a Building (heights, roof, guesses).
func makeBuilding(it rawBuilding, seed int) Building {
	tags := it.tags
	kind := "yes"
	if b := tags["building"]; b != "" && b != "no" {
		kind = b
	} else if bp := tags["building:part"]; bp != "" {
		kind = bp
	}
	area := math.Abs(polyArea(it.outer))
	roofShape := tags["roof:shape"]
	if roofShape == "" {
		roofShape = "flat"
	}
	roofHeight, ok := parseMeters(tags["roof:height"])
	if !ok {
		roofHeight = 3
		if roofShape == "flat" {
			roofHeight = 0
		}
	}
	levelsVal, hasLevels := parseNumber(tags["building:levels"])
	height, hasHeight := parseMeters(tags["height"])
	guessed := false
	if !hasHeight && hasLevels {
		height = levelsVal*3.2 + roofHeight
		hasHeight = true
	}
	if !hasHeight {
		height = guessHeight(kind, area, mulberry32(heightSeed(it.id, seed)))
		guessed = true
	}
	minHeight, ok := parseMeters(tags["min_height"])
	if !ok {
		minHeight = 0
		if minLevel, ok := parseNumber(tags["building:min_level"]); ok {
			minHeight = minLevel * 3.2
		}
	}
	b := Building{
		ID:         it.id,
		Outer:      it.outer,
		Holes:      it.holes,
		Height:     height,
		MinHeight:  minHeight,
		RoofShape:  roofShape,
		RoofHeight: roofHeight,
		Kind:       kind,
		Guessed:    guessed,
	}
	if b.Holes == nil {
		b.Holes = [][]geo.Point{}
	}
	if hasLevels {
		l := levelsVal
		b.Levels = &l
	}
	if c := tags["building:colour"]; c != "" {
		b.Color = &c
	}
	return b
}

// resolveBuildings decides which outlines to keep. When building:parts cover at least 80% of an
// outline (parts whose centroid lies inside the outline), the outline is dropped and the parts
// are used instead.
func resolveBuildings(outlines, parts []rawBuilding) []rawBuilding {
	type partInfo struct {
		b    rawBuilding
		area float64
		c    geo.Point
	}
	infos := make([]partInfo, len(parts))
	for i, p := range parts {
		infos[i] = partInfo{b: p, area: math.Abs(polyArea(p.outer)), c: centroid(p.outer)}
	}
	kept := make([]rawBuilding, 0, len(outlines)+len(parts))
	for _, o := range outlines {
		oa := math.Abs(polyArea(o.outer))
		covered := 0.0
		if len(infos) > 0 && oa > 0 {
			bb := bboxOf(o.outer)
			for _, pi := range infos {
				if pi.c[0] < bb.minX || pi.c[0] > bb.maxX || pi.c[1] < bb.minY || pi.c[1] > bb.maxY {
					continue
				}
				if pointInRing(pi.c[0], pi.c[1], o.outer) {
					covered += pi.area
				}
			}
		}
		if covered >= 0.8*oa {
			continue
		}
		kept = append(kept, o)
	}
	return append(kept, parts...)
}
