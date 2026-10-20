package osm

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"panelscape/internal/geo"
)

const (
	crossingOffset = 28.0 // m back from an intersection for crossing viewpoints
	crossingSide   = 7.0  // m sideways from the road centre line, i.e. on the sidewalk corner
	dedupeCrossing = 15.0 // m; intersections closer than this are treated as one
	maxCrossings   = 4
)

// graphKinds are the road kinds used for the navigation graph (viewpoints).
var graphKinds = map[string]bool{
	"trunk": true, "primary": true, "secondary": true, "tertiary": true, "unclassified": true,
	"residential": true, "living_street": true, "pedestrian": true,
}

// classWeight prefers wide major streets when choosing the central street.
var classWeight = map[string]float64{
	"trunk": 3, "primary": 3, "secondary": 2.6, "tertiary": 2.2, "unclassified": 1.2,
	"residential": 1, "living_street": 0.9, "pedestrian": 0.8,
}

// FindViewpoints suggests camera positions from the road graph of c.
//   - Up to four intersections nearest the centre where at least two distinct named roads meet
//     ("crossing"): the camera stands on the sidewalk about 28 m back along an approach road and
//     looks at the intersection.
//   - The longest major named road passing nearest the centre gives three viewpoints ("central
//     street"): eye level, low angle and looking down, standing about 30% along a segment of up to
//     120 m and looking about 40 m ahead along the street.
func FindViewpoints(c *CityData) []Viewpoint {
	views := []Viewpoint{}
	var graph []Road
	for _, r := range c.Roads {
		if len(r.Points) >= 2 && graphKinds[r.Kind] {
			graph = append(graph, r)
		}
	}
	if len(graph) == 0 {
		return views
	}

	// Vertex -> references, shared by ways so intersections are found from the topology.
	type vref struct{ ri, vi int }
	type vnode struct {
		pt    geo.Point
		refs  []vref
		names []string
	}
	vmap := map[string]*vnode{}
	var order []*vnode // insertion order, as a JS Map iterates
	for ri, r := range graph {
		for vi, p := range r.Points {
			k := pointKey(p)
			e, ok := vmap[k]
			if !ok {
				e = &vnode{pt: p}
				vmap[k] = e
				order = append(order, e)
			}
			e.refs = append(e.refs, vref{ri, vi})
			if r.Name != "" && !containsString(e.names, r.Name) {
				e.names = append(e.names, r.Name)
			}
		}
	}

	var candidates []*vnode
	for _, e := range order {
		if len(e.names) >= 2 {
			candidates = append(candidates, e)
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		a, b := candidates[i].pt, candidates[j].pt
		return math.Hypot(a[0], a[1]) < math.Hypot(b[0], b[1])
	})

	var chosen []*vnode
	for _, e := range candidates {
		if len(chosen) >= maxCrossings {
			break
		}
		tooNear := false
		for _, ch := range chosen {
			if math.Hypot(ch.pt[0]-e.pt[0], ch.pt[1]-e.pt[1]) < dedupeCrossing {
				tooNear = true
				break
			}
		}
		if tooNear {
			continue
		}
		// Approach: the reference giving the longest walk back from the intersection.
		var best struct {
			p      geo.Point
			walked float64
		}
		have := false
		for _, ref := range e.refs {
			pts := graph[ref.ri].Points
			for _, dir := range [2]int{-1, 1} {
				p, walked := walkFrom(pts, ref.vi, dir, crossingOffset)
				if !have || walked > best.walked {
					best.p, best.walked = p, walked
					have = true
				}
			}
		}
		if !have || best.walked < 2 {
			continue
		}
		chosen = append(chosen, e)
		// Step off the carriageway onto the sidewalk so the crossing is framed from a street corner.
		dx, dy := e.pt[0]-best.p[0], e.pt[1]-best.p[1]
		dl := math.Hypot(dx, dy)
		if dl == 0 {
			dl = 1
		}
		side := geo.Point{best.p[0] + (dy/dl)*crossingSide, best.p[1] - (dx/dl)*crossingSide}
		names := e.names
		if len(names) > 2 {
			names = names[:2]
		}
		views = append(views, Viewpoint{
			Label:     fmt.Sprintf("Crossing %d %s", len(chosen), strings.Join(names, " × ")),
			Kind:      "crossing",
			Position:  side,
			Target:    e.pt,
			EyeHeight: 1.6,
		})
	}

	// Central street: among named roads passing near the centre, prefer long major streets.
	type scored struct {
		r    Road
		dist float64
		s    float64
	}
	var named []scored
	for _, r := range graph {
		if r.Name == "" {
			continue
		}
		d, s := closestOnLine(r.Points, geo.Point{0, 0})
		named = append(named, scored{r: r, dist: d, s: s})
	}
	if len(named) > 0 {
		dmin := math.Inf(1)
		for _, s := range named {
			if s.dist < dmin {
				dmin = s.dist
			}
		}
		size := float64(c.Size)
		if c.Size == 0 {
			size = 300
		}
		reach := math.Max(dmin+60, size*0.4)
		var pool []scored
		for _, s := range named {
			if s.dist <= reach {
				pool = append(pool, s)
			}
		}
		score := func(s scored) float64 {
			w, ok := classWeight[s.r.Kind]
			if !ok {
				w = 0.5
			}
			return math.Min(lineLength(s.r.Points), 200) * w
		}
		if len(pool) == 0 {
			return views
		}
		sort.SliceStable(pool, func(i, j int) bool { return score(pool[i]) > score(pool[j]) })
		pick := pool[0]
		pts := pick.r.Points
		L := lineLength(pts)
		if L > 1 {
			seg := math.Min(120, L)
			s0 := math.Max(0, math.Min(pick.s-0.3*seg, L-seg))
			camS := s0 + 0.3*seg
			cam := pointAt(pts, camS)
			// Look about 40 m ahead along the street so a curving way still points down the road.
			target := pointAt(pts, math.Min(L, camS+40))
			name := pick.r.Name
			views = append(views,
				Viewpoint{Label: "Central street · eye level " + name, Kind: "street-eye", Position: cam, Target: target, EyeHeight: 1.6},
				Viewpoint{Label: "Central street · low angle " + name, Kind: "street-low", Position: cam, Target: target, EyeHeight: 0.4},
				Viewpoint{Label: "Central street · looking down " + name, Kind: "street-down", Position: cam, Target: target, EyeHeight: 25},
			)
		}
	}
	return views
}

func containsString(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}
