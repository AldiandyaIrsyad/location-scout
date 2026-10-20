package osm

import (
	"math"

	"panelscape/internal/geo"
)

const (
	streetTreeSpacing = 6.0 // m between street trees
	streetTreeClear   = 8.0 // m kept clear around junctions and dead ends
	treeCell          = 4.0 // m; bucket size of the minimum-distance grid
	buildingCell      = 20.0
)

var (
	streetTreeKinds  = []string{"trunk", "primary", "secondary", "tertiary"}
	greenTreeSpacing = map[string]float64{
		"forest": 6, "wood": 6, "scrub": 9, "park": 11, "garden": 11,
		"grass": 14, "meadow": 20, "village_green": 16,
	}
)

type cellKey [2]int

func cellOf(x, y, size float64) cellKey {
	return cellKey{int(math.Floor(x / size)), int(math.Floor(y / size))}
}

// generateTrees plants trees the OSM data does not map: street trees on both sides of major roads,
// and trees scattered on a jittered grid through green areas. Mapped trees (c.trees) are only used
// as obstacles for the minimum-distance test; they are not repeated in the result.
func generateTrees(c *collected, buildings []Building, size int) []geo.Point {
	half := float64(size) / 2
	var out []geo.Point

	// 4 m buckets for the minimum-distance test (3x3 neighbourhood, as in osm.js).
	grid := map[cellKey][]geo.Point{}
	tooClose := func(x, y, d float64) bool {
		cx, cy := int(math.Floor(x/treeCell)), int(math.Floor(y/treeCell))
		for i := -1; i <= 1; i++ {
			for j := -1; j <= 1; j++ {
				for _, q := range grid[cellKey{cx + i, cy + j}] {
					if math.Hypot(q[0]-x, q[1]-y) < d {
						return true
					}
				}
			}
		}
		return false
	}
	add := func(x, y float64) {
		p := geo.Point{x, y}
		out = append(out, p)
		k := cellOf(x, y, treeCell)
		grid[k] = append(grid[k], p)
	}
	for _, t := range c.trees {
		k := cellOf(t[0], t[1], treeCell)
		grid[k] = append(grid[k], t)
	}

	// Building footprints (bbox prefilter, indexed by 20 m cells).
	type bbox struct {
		x0, y0, x1, y1 float64
		ring           []geo.Point
	}
	boxes := make([]bbox, 0, len(buildings))
	bIndex := map[cellKey][]int{}
	for _, b := range buildings {
		bb := bboxOf(b.Outer)
		bx := bbox{x0: bb.minX - 1.5, y0: bb.minY - 1.5, x1: bb.maxX + 1.5, y1: bb.maxY + 1.5, ring: b.Outer}
		idx := len(boxes)
		boxes = append(boxes, bx)
		lo := cellOf(bx.x0, bx.y0, buildingCell)
		hi := cellOf(bx.x1, bx.y1, buildingCell)
		for cx := lo[0]; cx <= hi[0]; cx++ {
			for cy := lo[1]; cy <= hi[1]; cy++ {
				k := cellKey{cx, cy}
				bIndex[k] = append(bIndex[k], idx)
			}
		}
	}
	inBuilding := func(x, y float64) bool {
		for _, i := range bIndex[cellOf(x, y, buildingCell)] {
			bx := boxes[i]
			if x >= bx.x0 && x <= bx.x1 && y >= bx.y0 && y <= bx.y1 && pointInRing(x, y, bx.ring) {
				return true
			}
		}
		return false
	}
	inside := func(x, y float64) bool {
		return math.Abs(x) <= half && math.Abs(y) <= half
	}

	// Junctions: vertices where three or more road ends / pass-throughs meet, or dead ends (count 1).
	// A plain way end where two ways continue each other is not a junction.
	vcount := map[string]int{}
	vkey := func(p geo.Point) string { return toFixed(p[0], 1) + "," + toFixed(p[1], 1) }
	for _, r := range c.roads {
		for i, p := range r.Points {
			ends := 2 // a pass-through vertex joins two directions
			if i == 0 || i == len(r.Points)-1 {
				ends = 1
			}
			vcount[vkey(p)] += ends
		}
	}
	junctionGrid := map[cellKey][]geo.Point{}
	seen := map[string]bool{}
	for _, r := range c.roads {
		for _, p := range r.Points {
			k := vkey(p)
			n := vcount[k]
			if (n >= 3 || n == 1) && !seen[k] {
				seen[k] = true
				ck := cellOf(p[0], p[1], streetTreeClear)
				junctionGrid[ck] = append(junctionGrid[ck], p)
			}
		}
	}
	nearJunction := func(x, y float64) bool {
		cx, cy := int(math.Floor(x/streetTreeClear)), int(math.Floor(y/streetTreeClear))
		for i := -1; i <= 1; i++ {
			for j := -1; j <= 1; j++ {
				for _, q := range junctionGrid[cellKey{cx + i, cy + j}] {
					if math.Hypot(q[0]-x, q[1]-y) < streetTreeClear {
						return true
					}
				}
			}
		}
		return false
	}

	// 1. Street trees on both sidewalks of major roads.
	for _, r := range c.roads {
		if !contains(streetTreeKinds, r.Kind) || r.Tunnel || r.Bridge {
			continue
		}
		off := r.Width/2 + 1.3
		rnd := mulberry32(hashString("st" + r.ID))
		carry := streetTreeSpacing * rnd()
		for i := 0; i+1 < len(r.Points); i++ {
			a, b := r.Points[i], r.Points[i+1]
			dx, dy := b[0]-a[0], b[1]-a[1]
			length := math.Hypot(dx, dy)
			if length < 0.1 {
				continue
			}
			nx, ny := -dy/length, dx/length
			for d := carry; d < length; d += streetTreeSpacing {
				px := a[0] + (dx*d)/length
				py := a[1] + (dy*d)/length
				for _, side := range [2]float64{1, -1} {
					x := px + nx*off*side
					y := py + ny*off*side
					if !inside(x, y) || nearJunction(px, py) || inBuilding(x, y) || tooClose(x, y, 4) {
						continue
					}
					add(x, y)
				}
			}
			carry = math.Mod(math.Mod(carry-length, streetTreeSpacing)+streetTreeSpacing, streetTreeSpacing)
		}
	}

	// 2. Trees scattered through green areas on a jittered grid.
	for _, g := range c.green {
		sp, ok := greenTreeSpacing[g.Kind]
		if !ok {
			continue
		}
		bb := bboxOf(g.Outer)
		rnd := mulberry32(hashString("gr" + toFixed(bb.minX, 1) + toFixed(bb.minY, 1)))
		for gx := bb.minX; gx < bb.maxX; gx += sp {
			for gy := bb.minY; gy < bb.maxY; gy += sp {
				x := gx + sp*(0.15+0.7*rnd())
				y := gy + sp*(0.15+0.7*rnd())
				if !inside(x, y) || !pointInRing(x, y, g.Outer) || inAnyRing(x, y, g.Holes) {
					continue
				}
				if inBuilding(x, y) || tooClose(x, y, sp*0.5) {
					continue
				}
				add(x, y)
			}
		}
	}
	return out
}

func inAnyRing(x, y float64, rings [][]geo.Point) bool {
	for _, r := range rings {
		if pointInRing(x, y, r) {
			return true
		}
	}
	return false
}
