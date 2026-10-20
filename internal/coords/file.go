package coords

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
)

// Port of the KML / KMZ / GeoJSON half of web/js/coords.js.

// ErrNoLocation reports that a file parsed fine but holds no usable coordinates.
var ErrNoLocation = errors.New("coords: no location found in file")

// maxKMLBytes bounds the KML document expanded from a KMZ, guarding against zip bombs.
const maxKMLBytes = 64 << 20

// ParseFile reads a location from a KML, KMZ, GeoJSON (.geojson or .json) or other KML-like file.
//
// KML returns the first LookAt, Camera or Point in document order. KMZ uses the first .kml entry of
// the archive. GeoJSON returns the first Point, or the bbox centre of the first other geometry.
// The name comes from the matching element or feature properties when present.
func ParseFile(name string, data []byte) (*Location, error) {
	lower := strings.ToLower(name)
	if strings.HasSuffix(lower, ".geojson") || strings.HasSuffix(lower, ".json") {
		return parseGeoJSON(data)
	}
	isZip := len(data) > 1 && data[0] == 'P' && data[1] == 'K'
	if isZip || strings.HasSuffix(lower, ".kmz") {
		kml, err := kmlFromKMZ(data)
		if err != nil {
			return nil, err
		}
		return parseKML(kml)
	}
	return parseKML(data)
}

// kmlFromKMZ returns the bytes of the first .kml entry in the archive.
func kmlFromKMZ(data []byte) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("coords: read KMZ: %w", err)
	}
	for _, f := range zr.File {
		if !strings.HasSuffix(strings.ToLower(f.Name), ".kml") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, fmt.Errorf("coords: open %s in KMZ: %w", f.Name, err)
		}
		b, err := io.ReadAll(io.LimitReader(rc, maxKMLBytes+1))
		closeErr := rc.Close()
		if err != nil {
			return nil, fmt.Errorf("coords: read %s in KMZ: %w", f.Name, err)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("coords: close %s in KMZ: %w", f.Name, closeErr)
		}
		if len(b) > maxKMLBytes {
			return nil, fmt.Errorf("coords: %s in KMZ is larger than %d bytes", f.Name, maxKMLBytes)
		}
		return b, nil
	}
	return nil, fmt.Errorf("%w: KMZ has no .kml entry", ErrNoLocation)
}

// ---------------------------------------------------------------------------
// KML
// ---------------------------------------------------------------------------

// xnode is a minimal element tree: enough for DOM-style lookups (children by name, text content,
// ancestors) and document-order traversal.
type xnode struct {
	name     string
	parent   *xnode
	children []*xnode
	text     strings.Builder
}

// buildTree parses the XML document into xnode elements. The returned root is a virtual document
// node with no name; the document element is its only child.
func buildTree(data []byte) (*xnode, error) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	root := &xnode{}
	cur := root
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("coords: parse KML: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			n := &xnode{name: t.Name.Local, parent: cur}
			cur.children = append(cur.children, n)
			cur = n
		case xml.EndElement:
			if cur.parent != nil {
				cur = cur.parent
			}
		case xml.CharData:
			cur.text.Write(t)
		}
	}
	return root, nil
}

// textContent returns the element's text, including its descendants' text, like DOM textContent.
func textContent(n *xnode) string {
	var b strings.Builder
	var walk func(*xnode)
	walk = func(x *xnode) {
		b.WriteString(x.text.String())
		for _, c := range x.children {
			walk(c)
		}
	}
	walk(n)
	return b.String()
}

func childElement(n *xnode, name string) *xnode {
	for _, c := range n.children {
		if c.name == name {
			return c
		}
	}
	return nil
}

// childNumber reads a child element's text as a number, as JavaScript parseFloat does.
func childNumber(n *xnode, name string) (float64, bool) {
	c := childElement(n, name)
	if c == nil {
		return 0, false
	}
	v, ok := parseFloatPrefix(textContent(c))
	if !ok || !isFinite(v) {
		return 0, false
	}
	return v, true
}

// nearestName returns the name of the closest element (self or ancestor) with a direct <name> child.
// The virtual document node is not considered.
func nearestName(n *xnode) string {
	for node := n; node != nil && node.parent != nil; node = node.parent {
		if nm := childElement(node, "name"); nm != nil {
			if s := strings.TrimSpace(textContent(nm)); s != "" {
				return s
			}
		}
	}
	return ""
}

// parseKML returns the first LookAt, Camera or Point (document order) with valid coordinates.
func parseKML(data []byte) (*Location, error) {
	root, err := buildTree(data)
	if err != nil {
		return nil, err
	}
	var found *Location
	var walk func(*xnode) bool
	walk = func(n *xnode) bool {
		for _, c := range n.children {
			if loc, ok := kmlElement(c); ok {
				found = loc
				return true
			}
			if walk(c) {
				return true
			}
		}
		return false
	}
	if !walk(root) {
		return nil, ErrNoLocation
	}
	return found, nil
}

// kmlElement reads a location from a LookAt, Camera or Point element.
func kmlElement(el *xnode) (*Location, bool) {
	switch el.name {
	case "LookAt", "Camera":
		lat, okLat := childNumber(el, "latitude")
		lon, okLon := childNumber(el, "longitude")
		if !okLat || !okLon || !isValidLatLon(lat, lon) {
			return nil, false
		}
		loc := &Location{Lat: lat, Lon: lon, Name: nearestName(el)}
		if h, ok := childNumber(el, "heading"); ok {
			loc.Heading = &h
		}
		if t, ok := childNumber(el, "tilt"); ok {
			loc.Tilt = &t
		}
		return loc, true
	case "Point":
		ce := childElement(el, "coordinates")
		if ce == nil {
			return nil, false
		}
		fields := strings.Fields(textContent(ce))
		if len(fields) == 0 {
			return nil, false
		}
		parts := strings.Split(fields[0], ",")
		if len(parts) < 2 {
			return nil, false
		}
		lon, okLon := parseFloatPrefix(parts[0])
		lat, okLat := parseFloatPrefix(parts[1])
		if !okLon || !okLat || !isValidLatLon(lat, lon) {
			return nil, false
		}
		return &Location{Lat: lat, Lon: lon, Name: nearestName(el)}, true
	}
	return nil, false
}

// ---------------------------------------------------------------------------
// GeoJSON (coordinates are [lon, lat])
// ---------------------------------------------------------------------------

type bbox struct {
	minX, minY, maxX, maxY float64
}

func parseGeoJSON(data []byte) (*Location, error) {
	var doc any
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("coords: parse GeoJSON: %w", err)
	}
	obj, ok := doc.(map[string]any)
	if !ok {
		return nil, ErrNoLocation
	}

	var items []any
	if obj["type"] == "FeatureCollection" {
		switch fs := obj["features"].(type) {
		case nil:
		case []any:
			items = fs
		default:
			return nil, fmt.Errorf("coords: GeoJSON features is not an array")
		}
	} else {
		items = []any{obj}
	}

	type feature struct {
		geom  map[string]any
		props map[string]any
	}
	var feats []feature
	for _, it := range items {
		m, ok := it.(map[string]any)
		if !ok {
			continue
		}
		if m["type"] == "Feature" {
			g, _ := m["geometry"].(map[string]any)
			if g == nil {
				continue
			}
			p, _ := m["properties"].(map[string]any)
			feats = append(feats, feature{geom: g, props: p})
			continue
		}
		feats = append(feats, feature{geom: m})
	}

	// First Point wins; otherwise the first geometry that has coordinates.
	var pick *feature
	var pickBox bbox
	for i := range feats {
		if t, _ := feats[i].geom["type"].(string); t != "Point" {
			continue
		}
		if b, ok := geoBounds(feats[i].geom); ok {
			pick, pickBox = &feats[i], b
			break
		}
	}
	if pick == nil {
		for i := range feats {
			if b, ok := geoBounds(feats[i].geom); ok {
				pick, pickBox = &feats[i], b
				break
			}
		}
	}
	if pick == nil {
		return nil, ErrNoLocation
	}

	lon := (pickBox.minX + pickBox.maxX) / 2
	lat := (pickBox.minY + pickBox.maxY) / 2
	if !isValidLatLon(lat, lon) {
		return nil, ErrNoLocation
	}
	loc := &Location{Lat: lat, Lon: lon}

	candidates := []any{pick.props["name"], pick.props["title"], obj["name"], obj["title"]}
	for _, v := range candidates {
		if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
			loc.Name = strings.TrimSpace(s)
			break
		}
	}
	return loc, nil
}

// geoBounds returns the bounding box of every position in a GeoJSON geometry. ok is false when the
// geometry has no positions.
func geoBounds(geom map[string]any) (bbox, bool) {
	acc := bbox{minX: math.Inf(1), minY: math.Inf(1), maxX: math.Inf(-1), maxY: math.Inf(-1)}
	addGeometry(geom, &acc)
	return acc, acc.minX != math.Inf(1)
}

func addGeometry(g map[string]any, acc *bbox) {
	if g == nil {
		return
	}
	if g["type"] == "GeometryCollection" {
		geoms, _ := g["geometries"].([]any)
		for _, x := range geoms {
			if m, ok := x.(map[string]any); ok {
				addGeometry(m, acc)
			}
		}
		return
	}
	addCoordinates(g["coordinates"], acc)
}

func addCoordinates(c any, acc *bbox) {
	arr, ok := c.([]any)
	if !ok {
		return
	}
	if len(arr) >= 2 {
		x, okX := arr[0].(float64)
		y, okY := arr[1].(float64)
		if okX && okY {
			if !isFinite(x) || !isFinite(y) {
				return
			}
			acc.minX = math.Min(acc.minX, x)
			acc.maxX = math.Max(acc.maxX, x)
			acc.minY = math.Min(acc.minY, y)
			acc.maxY = math.Max(acc.maxY, y)
			return
		}
	}
	for _, x := range arr {
		addCoordinates(x, acc)
	}
}
