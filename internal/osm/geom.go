package osm

import (
	"math"
	"strconv"
	"strings"

	"panelscape/internal/geo"
)

// box is an axis-aligned rectangle in local meters.
type box struct {
	minX, minY, maxX, maxY float64
}

func (b box) contains(p geo.Point) bool {
	return p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY
}

// toFixed formats x like JavaScript's Number.prototype.toFixed(d): exact decimal expansion,
// ties rounded away from zero (strconv would round ties to even). Used wherever osm.js built
// string keys from coordinates so that the same inputs give the same keys and seeds.
func toFixed(x float64, d int) string {
	if x == 0 {
		x = 0 // normalise -0
	}
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return strconv.FormatFloat(x, 'f', d, 64)
	}
	ax := math.Abs(x)
	s := strconv.FormatFloat(ax, 'f', d+25, 64)
	dot := strings.IndexByte(s, '.')
	digits := make([]byte, 0, len(s))
	digits = append(digits, s[:dot]...)
	digits = append(digits, s[dot+1:dot+1+d]...)
	if s[dot+1+d] >= '5' {
		i := len(digits) - 1
		for ; i >= 0; i-- {
			if digits[i] == '9' {
				digits[i] = '0'
				continue
			}
			digits[i]++
			break
		}
		if i < 0 {
			digits = append([]byte{'1'}, digits...)
		}
	}
	intLen := len(digits) - d
	var b strings.Builder
	if x < 0 {
		b.WriteByte('-')
	}
	b.Write(digits[:intLen])
	if d > 0 {
		b.WriteByte('.')
		b.Write(digits[intLen:])
	}
	return b.String()
}

// polyArea is the signed shoelace area: positive for counter-clockwise (x east, y north).
func polyArea(pts []geo.Point) float64 {
	a := 0.0
	n := len(pts)
	for i := 0; i < n; i++ {
		p := pts[i]
		q := pts[(i+1)%n]
		a += p[0]*q[1] - q[0]*p[1]
	}
	return a / 2
}

// orient reverses the ring in place when needed so it is CCW (ccw=true) or CW (ccw=false).
func orient(ring []geo.Point, ccw bool) []geo.Point {
	a := polyArea(ring)
	if (a > 0) != ccw && a != 0 {
		reversePoints(ring)
	}
	return ring
}

func reversePoints(pts []geo.Point) {
	for i, j := 0, len(pts)-1; i < j; i, j = i+1, j-1 {
		pts[i], pts[j] = pts[j], pts[i]
	}
}

// centroid is the vertex average (not the area centroid), as in osm.js.
func centroid(pts []geo.Point) geo.Point {
	x, y := 0.0, 0.0
	for _, p := range pts {
		x += p[0]
		y += p[1]
	}
	n := float64(len(pts))
	return geo.Point{x / n, y / n}
}

func bboxOf(pts []geo.Point) box {
	b := box{math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)}
	for _, p := range pts {
		if p[0] < b.minX {
			b.minX = p[0]
		}
		if p[0] > b.maxX {
			b.maxX = p[0]
		}
		if p[1] < b.minY {
			b.minY = p[1]
		}
		if p[1] > b.maxY {
			b.maxY = p[1]
		}
	}
	return b
}

// pointInRing is the even-odd rule test.
func pointInRing(x, y float64, ring []geo.Point) bool {
	inside := false
	for i, j := 0, len(ring)-1; i < len(ring); j, i = i, i+1 {
		xi, yi := ring[i][0], ring[i][1]
		xj, yj := ring[j][0], ring[j][1]
		if (yi > y) != (yj > y) && x < ((xj-xi)*(y-yi))/(yj-yi)+xi {
			inside = !inside
		}
	}
	return inside
}

// clipPolyline clips a polyline to the box (Liang-Barsky per segment) and returns the inside
// pieces, each with at least two points, in order.
func clipPolyline(line []geo.Point, b box) [][]geo.Point {
	var pieces [][]geo.Point
	var cur []geo.Point
	for i := 0; i+1 < len(line); i++ {
		a, c := line[i], line[i+1]
		dx, dy := c[0]-a[0], c[1]-a[1]
		p := [4]float64{-dx, dx, -dy, dy}
		q := [4]float64{a[0] - b.minX, b.maxX - a[0], a[1] - b.minY, b.maxY - a[1]}
		t0, t1 := 0.0, 1.0
		hit := true
		for k := 0; k < 4 && hit; k++ {
			if p[k] == 0 {
				if q[k] < 0 {
					hit = false
				}
				continue
			}
			t := q[k] / p[k]
			if p[k] < 0 {
				if t > t1 {
					hit = false
				} else if t > t0 {
					t0 = t
				}
			} else {
				if t < t0 {
					hit = false
				} else if t < t1 {
					t1 = t
				}
			}
		}
		if !hit {
			if cur != nil {
				pieces = append(pieces, cur)
				cur = nil
			}
			continue
		}
		P0 := a
		if t0 > 0 {
			P0 = geo.Point{a[0] + dx*t0, a[1] + dy*t0}
		}
		P1 := c
		if t1 < 1 {
			P1 = geo.Point{a[0] + dx*t1, a[1] + dy*t1}
		}
		if cur == nil {
			cur = []geo.Point{P0}
		}
		cur = append(cur, P1)
		if t1 < 1 { // left the box inside this segment
			pieces = append(pieces, cur)
			cur = nil
		}
	}
	if cur != nil {
		pieces = append(pieces, cur)
	}
	out := pieces[:0]
	for _, pc := range pieces {
		if len(pc) >= 2 {
			out = append(out, pc)
		}
	}
	return out
}

func segmentHitsBox(a, c geo.Point, b box) bool {
	t0, t1 := 0.0, 1.0
	dx, dy := c[0]-a[0], c[1]-a[1]
	p := [4]float64{-dx, dx, -dy, dy}
	q := [4]float64{a[0] - b.minX, b.maxX - a[0], a[1] - b.minY, b.maxY - a[1]}
	for i := 0; i < 4; i++ {
		if p[i] == 0 {
			if q[i] < 0 {
				return false
			}
			continue
		}
		t := q[i] / p[i]
		if p[i] < 0 {
			if t > t1 {
				return false
			}
			if t > t0 {
				t0 = t
			}
		} else {
			if t < t0 {
				return false
			}
			if t < t1 {
				t1 = t
			}
		}
	}
	return true
}

// intersectsBox reports whether a feature touches the box: a vertex inside, an edge crossing the
// box, or (for closed rings) the box centre inside the ring. Features are not clipped.
func intersectsBox(pts []geo.Point, closed bool, b box) bool {
	for _, p := range pts {
		if b.contains(p) {
			return true
		}
	}
	n := len(pts)
	edges := n - 1
	if closed {
		edges = n
	}
	for i := 0; i < edges; i++ {
		if segmentHitsBox(pts[i], pts[(i+1)%n], b) {
			return true
		}
	}
	if closed {
		cx := (b.minX + b.maxX) / 2
		cy := (b.minY + b.maxY) / 2
		if pointInRing(cx, cy, pts) {
			return true
		}
	}
	return false
}

func perpDist(p, a, b geo.Point) float64 {
	dx, dy := b[0]-a[0], b[1]-a[1]
	len2 := dx*dx + dy*dy
	t := 0.0
	if len2 > 0 {
		t = ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / len2
	}
	t = math.Max(0, math.Min(1, t))
	return math.Hypot(p[0]-(a[0]+dx*t), p[1]-(a[1]+dy*t))
}

// simplifyDP is an iterative Douglas-Peucker on an open polyline. Endpoints are always kept.
func simplifyDP(pts []geo.Point, eps float64) []geo.Point {
	if len(pts) < 3 {
		return append([]geo.Point(nil), pts...)
	}
	keep := make([]bool, len(pts))
	keep[0] = true
	keep[len(pts)-1] = true
	stack := [][2]int{{0, len(pts) - 1}}
	for len(stack) > 0 {
		se := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		s, e := se[0], se[1]
		maxD, idx := 0.0, -1
		for i := s + 1; i < e; i++ {
			d := perpDist(pts[i], pts[s], pts[e])
			if d > maxD {
				maxD = d
				idx = i
			}
		}
		if maxD > eps && idx >= 0 {
			keep[idx] = true
			stack = append(stack, [2]int{s, idx}, [2]int{idx, e})
		}
	}
	out := make([]geo.Point, 0, len(pts))
	for i, p := range pts {
		if keep[i] {
			out = append(out, p)
		}
	}
	return out
}

// simplifyRing simplifies a closed ring; the original is kept if the result would be degenerate.
func simplifyRing(ring []geo.Point, eps float64) []geo.Point {
	if len(ring) < 4 {
		return ring
	}
	arr := append(append([]geo.Point(nil), ring...), ring[0])
	s := simplifyDP(arr, eps)
	s = s[:len(s)-1]
	if len(s) >= 3 {
		return s
	}
	return ring
}

// sampleLine places points every spacing meters along the polyline, starting at the first vertex.
func sampleLine(pts []geo.Point, spacing float64) []geo.Point {
	var out []geo.Point
	nextS := 0.0
	cum := 0.0
	for i := 0; i+1 < len(pts); i++ {
		a, b := pts[i], pts[i+1]
		L := math.Hypot(b[0]-a[0], b[1]-a[1])
		if L <= 0 {
			continue
		}
		for nextS <= cum+L {
			u := (nextS - cum) / L
			out = append(out, geo.Point{a[0] + (b[0]-a[0])*u, a[1] + (b[1]-a[1])*u})
			nextS += spacing
		}
		cum += L
	}
	return out
}

func lineLength(pts []geo.Point) float64 {
	L := 0.0
	for i := 0; i+1 < len(pts); i++ {
		L += math.Hypot(pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1])
	}
	return L
}

// closestOnLine returns the distance from c to the polyline and the arc length to that point.
func closestOnLine(pts []geo.Point, c geo.Point) (dist, s float64) {
	dist = math.Inf(1)
	acc := 0.0
	for i := 0; i+1 < len(pts); i++ {
		a, b := pts[i], pts[i+1]
		dx, dy := b[0]-a[0], b[1]-a[1]
		len2 := dx*dx + dy*dy
		L := math.Sqrt(len2)
		t := 0.0
		if len2 > 0 {
			t = ((c[0]-a[0])*dx + (c[1]-a[1])*dy) / len2
		}
		t = math.Max(0, math.Min(1, t))
		d := math.Hypot(c[0]-(a[0]+dx*t), c[1]-(a[1]+dy*t))
		if d < dist {
			dist = d
			s = acc + t*L
		}
		acc += L
	}
	return dist, s
}

// pointAt returns the point at arc length s along the polyline (clamped to the end).
func pointAt(pts []geo.Point, s float64) geo.Point {
	acc := 0.0
	for i := 0; i+1 < len(pts); i++ {
		a, b := pts[i], pts[i+1]
		L := math.Hypot(b[0]-a[0], b[1]-a[1])
		if L > 0 && acc+L >= s {
			u := math.Max(0, (s-acc)/L)
			return geo.Point{a[0] + (b[0]-a[0])*u, a[1] + (b[1]-a[1])*u}
		}
		acc += L
	}
	return pts[len(pts)-1]
}

// walkFrom walks from vertex vi along the polyline in direction dir (-1 or +1) for up to dist
// meters. It returns the point reached and the distance actually walked.
func walkFrom(pts []geo.Point, vi, dir int, dist float64) (geo.Point, float64) {
	cur := pts[vi]
	remaining := dist
	i := vi
	for remaining > 0 {
		j := i + dir
		if j < 0 || j >= len(pts) {
			break
		}
		nxt := pts[j]
		seg := math.Hypot(nxt[0]-cur[0], nxt[1]-cur[1])
		if seg > 0 && seg >= remaining {
			u := remaining / seg
			return geo.Point{cur[0] + (nxt[0]-cur[0])*u, cur[1] + (nxt[1]-cur[1])*u}, dist
		}
		remaining -= seg
		cur = nxt
		i = j
	}
	return cur, dist - remaining
}

// cleanRing drops consecutive duplicates and the closing point. Returns nil with fewer than 3 points.
func cleanRing(pts []geo.Point) []geo.Point {
	out := make([]geo.Point, 0, len(pts))
	for _, p := range pts {
		if len(out) == 0 || !nearPoint(out[len(out)-1], p) {
			out = append(out, p)
		}
	}
	for len(out) > 1 && nearPoint(out[0], out[len(out)-1]) {
		out = out[:len(out)-1]
	}
	if len(out) < 3 {
		return nil
	}
	return out
}

// cleanLine drops consecutive duplicates of an open polyline. Returns nil with fewer than 2 points.
func cleanLine(pts []geo.Point) []geo.Point {
	out := make([]geo.Point, 0, len(pts))
	for _, p := range pts {
		if len(out) == 0 || !nearPoint(out[len(out)-1], p) {
			out = append(out, p)
		}
	}
	if len(out) < 2 {
		return nil
	}
	return out
}

func nearPoint(a, b geo.Point) bool {
	return math.Abs(a[0]-b[0]) < 1e-6 && math.Abs(a[1]-b[1]) < 1e-6
}

func pointKey(p geo.Point) string {
	return toFixed(p[0], 2) + "," + toFixed(p[1], 2)
}
