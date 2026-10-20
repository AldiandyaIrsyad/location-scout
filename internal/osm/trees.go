package osm

import (
	"math"

	"panelscape/internal/geo"
)

const (
	treeCell        = 4.0  // m; bucket size of the minimum-distance grid
	buildingCell    = 20.0 // m; bucket size for building footprints
	spatialCell     = 24.0 // m; bucket size for road/blocked-area lookup
	maxSpatialCells = 256  // keep one unusually large feature out of every bucket

	// Inferred trees are a visual fallback for mapped canopy polygons. Keep a
	// hard cap so an unusually large or malformed OSM feature cannot produce an
	// unbounded response.
	inferredTreeBudget = 2048
	maxTreeCandidates  = inferredTreeBudget * 16
)

// Only landcover that explicitly describes tree canopy is safe to populate
// with inferred trees. Parks, grass, meadows, gardens and similar labels do
// not imply that the area contains trees.
var canopyTreeSpacing = map[string]float64{
	"forest":  6,
	"wood":    6,
	"orchard": 9,
}

type cellKey [2]int

// featureIndex narrows point queries to nearby features. Features whose bounds
// would occupy too many cells stay in global so indexing cannot become
// unbounded for a very large mapped polygon or road.
type featureIndex struct {
	cells  map[cellKey][]int
	global []int
}

func newFeatureIndex() featureIndex {
	return featureIndex{cells: map[cellKey][]int{}}
}

func addFeatureRange(index *featureIndex, feature int, bounds, extent box) {
	if bounds.maxX < extent.minX || bounds.minX > extent.maxX ||
		bounds.maxY < extent.minY || bounds.minY > extent.maxY {
		return
	}
	// Candidate points never leave extent. Clipping the indexed range here
	// still includes the full clearance corridor because callers expand the
	// feature bounds before this function is called.
	minX := math.Max(bounds.minX, extent.minX)
	minY := math.Max(bounds.minY, extent.minY)
	maxX := math.Min(bounds.maxX, extent.maxX)
	maxY := math.Min(bounds.maxY, extent.maxY)
	lo := cellOf(minX, minY, spatialCell)
	hi := cellOf(maxX, maxY, spatialCell)
	nx := int64(hi[0]) - int64(lo[0]) + 1
	ny := int64(hi[1]) - int64(lo[1]) + 1
	if nx <= 0 || ny <= 0 {
		return
	}
	if nx > maxSpatialCells || ny > maxSpatialCells || nx*ny > maxSpatialCells {
		index.global = append(index.global, feature)
		return
	}
	for x := lo[0]; x <= hi[0]; x++ {
		for y := lo[1]; y <= hi[1]; y++ {
			index.cells[cellKey{x, y}] = append(index.cells[cellKey{x, y}], feature)
		}
	}
}

func cellOf(x, y, size float64) cellKey {
	return cellKey{int(math.Floor(x / size)), int(math.Floor(y / size))}
}

// generateTrees infers trees only inside explicitly mapped tree-canopy areas.
// All mapped trees, including natural=tree nodes and sampled tree_row ways,
// remain in c.trees and are used as obstacles here; Parse appends those mapped
// points unchanged to the inferred result.
func generateTrees(c *collected, buildings []Building, size int) []geo.Point {
	half := float64(size) / 2
	var out []geo.Point

	// Four metre buckets keep the minimum-distance check bounded to a 3x3
	// neighbourhood. Mapped trees are inserted first so inferred points never
	// overlap an explicit OSM tree.
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

	// Building footprints and their inner rings are blocked. The rings are
	// indexed by a 20 m bucket so large city responses do not scan every
	// building for every candidate.
	type bbox struct {
		x0, y0, x1, y1 float64
		ring           []geo.Point
	}
	boxes := make([]bbox, 0, len(buildings))
	bIndex := map[cellKey][]int{}
	addBuildingRing := func(ring []geo.Point) {
		if len(ring) < 3 {
			return
		}
		bb := bboxOf(ring)
		// Keep a small margin around the footprint so an inferred crown does not
		// appear to grow directly through a wall.
		bx := bbox{x0: bb.minX - 1.5, y0: bb.minY - 1.5, x1: bb.maxX + 1.5, y1: bb.maxY + 1.5, ring: ring}
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
	for _, b := range buildings {
		addBuildingRing(b.Outer)
		for _, h := range b.Holes {
			addBuildingRing(h)
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

	cityBox := box{minX: -half, minY: -half, maxX: half, maxY: half}
	// Index roads by segment bounds expanded by their exact exclusion width.
	// A road with a very large span is kept in global rather than filling a
	// potentially huge number of cells. The final distance check remains the
	// same as before, so this index can only remove impossible candidates.
	roadIndex := newFeatureIndex()
	for ri, r := range c.roads {
		if len(r.Points) < 2 {
			continue
		}
		width := r.Width
		if width <= 0 {
			width = 2
		}
		clearance := width/2 + 1.5
		for i := 0; i+1 < len(r.Points); i++ {
			a, b := r.Points[i], r.Points[i+1]
			addFeatureRange(&roadIndex, ri, box{
				minX: math.Min(a[0], b[0]) - clearance,
				minY: math.Min(a[1], b[1]) - clearance,
				maxX: math.Max(a[0], b[0]) + clearance,
				maxY: math.Max(a[1], b[1]) + clearance,
			}, cityBox)
		}
	}
	roadSeen := make([]int, len(c.roads))
	roadMark := 0

	// Water and paved areas are independent OSM layers and may overlap a
	// canopy polygon. Respect holes in those areas, since a hole is usable land.
	blockedAreas := make([]Area, 0, len(c.water)+len(c.areas))
	blockedAreas = append(blockedAreas, c.water...)
	blockedAreas = append(blockedAreas, c.areas...)
	areaIndex := newFeatureIndex()
	for ai, a := range blockedAreas {
		if len(a.Outer) < 3 {
			continue
		}
		addFeatureRange(&areaIndex, ai, bboxOf(a.Outer), cityBox)
	}
	inBlockedArea := func(x, y float64) bool {
		insideArea := func(a Area) bool {
			if !pointInRing(x, y, a.Outer) || inAnyRing(x, y, a.Holes) {
				return false
			}
			return true
		}
		for _, ai := range areaIndex.global {
			if insideArea(blockedAreas[ai]) {
				return true
			}
		}
		for _, ai := range areaIndex.cells[cellOf(x, y, spatialCell)] {
			if insideArea(blockedAreas[ai]) {
				return true
			}
		}
		return false
	}

	// Every highway, including footways, paths and cycleways, is treated as a
	// blocked corridor. Width is supplied by OSM parsing; synthetic callers may
	// omit it, so use a conservative 2 m default.
	nearRoad := func(x, y float64) bool {
		p := geo.Point{x, y}
		roadMark++
		if roadMark == 0 {
			clear(roadSeen)
			roadMark = 1
		}
		check := func(ri int) bool {
			if roadSeen[ri] == roadMark {
				return false
			}
			roadSeen[ri] = roadMark
			r := c.roads[ri]
			if len(r.Points) < 2 {
				return false
			}
			width := r.Width
			if width <= 0 {
				width = 2
			}
			if d, _ := closestOnLine(r.Points, p); d <= width/2+1.5 {
				return true
			}
			return false
		}
		for _, ri := range roadIndex.global {
			if check(ri) {
				return true
			}
		}
		for _, ri := range roadIndex.cells[cellOf(x, y, spatialCell)] {
			if check(ri) {
				return true
			}
		}
		return false
	}

	inside := func(x, y float64) bool {
		return math.Abs(x) <= half && math.Abs(y) <= half
	}

	// Stop after a bounded number of candidate checks as well as a bounded
	// number of accepted points. The candidate limit matters when a huge canopy
	// polygon is entirely covered by roads, water, or buildings.
	candidates := 0
	canAdd := func(x, y, spacing float64) bool {
		if len(out) >= inferredTreeBudget {
			return false
		}
		if !inside(x, y) || inBuilding(x, y) || inBlockedArea(x, y) || nearRoad(x, y) {
			return false
		}
		if tooClose(x, y, spacing*0.5) {
			return false
		}
		add(x, y)
		return true
	}

	// The grid is filled in raster order, so a budget that runs out part-way would leave the far
	// side of a big wood bare and give later woods nothing. Estimate how many trees all canopy
	// areas want at their natural spacing and coarsen every grid by one common factor until that
	// fits the budget, so the whole canopy is covered evenly.
	wanted := 0.0
	for _, g := range c.green {
		if sp, ok := canopyTreeSpacing[g.Kind]; ok && len(g.Outer) >= 3 {
			wanted += canopyCells(g, sp, half)
		}
	}
	// Aim below the budget so neither it nor the candidate cap is hit before the last area.
	coarsen := math.Max(1, math.Sqrt(wanted/(inferredTreeBudget*0.75)))

	for _, g := range c.green {
		sp, ok := canopyTreeSpacing[g.Kind]
		if !ok || len(g.Outer) < 3 || len(out) >= inferredTreeBudget || candidates >= maxTreeCandidates {
			continue
		}
		sp *= coarsen
		bb := bboxOf(g.Outer)
		// Clamp the grid to the requested city square so a clipped OSM polygon
		// cannot cause work outside the response bounds.
		minX, maxX := math.Max(bb.minX, -half), math.Min(bb.maxX, half)
		minY, maxY := math.Max(bb.minY, -half), math.Min(bb.maxY, half)
		if minX >= maxX || minY >= maxY {
			continue
		}
		rnd := mulberry32(hashString("gr" + toFixed(bb.minX, 1) + "," + toFixed(bb.minY, 1) + "," + g.Kind))
		for gx := minX; gx < maxX && len(out) < inferredTreeBudget && candidates < maxTreeCandidates; gx += sp {
			for gy := minY; gy < maxY && len(out) < inferredTreeBudget && candidates < maxTreeCandidates; gy += sp {
				x := gx + sp*(0.15+0.7*rnd())
				y := gy + sp*(0.15+0.7*rnd())
				// Count every sampled grid position, including positions outside a
				// concave polygon. This keeps pathological skinny rings bounded.
				candidates++
				if !pointInRing(x, y, g.Outer) || inAnyRing(x, y, g.Holes) {
					continue
				}
				canAdd(x, y, sp)
			}
		}
	}
	return out
}

// canopyCells estimates how many grid cells of side sp the canopy area covers inside the city
// square: the smaller of its polygon area and its clamped bounding box.
func canopyCells(g Area, sp, half float64) float64 {
	bb := bboxOf(g.Outer)
	w := math.Min(bb.maxX, half) - math.Max(bb.minX, -half)
	h := math.Min(bb.maxY, half) - math.Max(bb.minY, -half)
	if w <= 0 || h <= 0 {
		return 0
	}
	ring := 0.0
	for i, p := range g.Outer {
		q := g.Outer[(i+1)%len(g.Outer)]
		ring += p[0]*q[1] - q[0]*p[1]
	}
	return math.Min(w*h, math.Abs(ring)/2) / (sp * sp)
}

func inAnyRing(x, y float64, rings [][]geo.Point) bool {
	for _, r := range rings {
		if pointInRing(x, y, r) {
			return true
		}
	}
	return false
}
