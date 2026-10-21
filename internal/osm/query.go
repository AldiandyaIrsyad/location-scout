package osm

import (
	"fmt"
	"strings"

	"panelscape/internal/geo"
)

// alt builds an anchored alternation for an Overpass regex, e.g. ^(park|garden)$.
func alt(list []string) string {
	return "^(" + strings.Join(list, "|") + ")$"
}

// bboxStr formats a bounding box as an Overpass (south,west,north,east) filter.
func bboxStr(b geo.BBox) string {
	return fmt.Sprintf("(%s,%s,%s,%s)", toFixed(b.South, 7), toFixed(b.West, 7), toFixed(b.North, 7), toFixed(b.East, 7))
}

// cityQuery is the Overpass QL for everything inside the box (same as osm.js cityQuery).
func cityQuery(b geo.BBox) string {
	bb := bboxStr(b)
	leisure := alt(greenLeisure)
	landuse := alt(greenLanduse)
	natural := alt(greenNatural)
	rail := alt(railKinds)
	landmarkKinds := alt([]string{"memorial", "monument"})
	artworkKinds := alt([]string{"statue", "sculpture"})
	barriers := alt(barrierKinds)
	return fmt.Sprintf(`[out:json][timeout:60];
(
  way["building"]%[1]s;
  relation["building"]%[1]s;
  way["building:part"]%[1]s;
  relation["building:part"]%[1]s;
  way["highway"]%[1]s;
  way["railway"~"%[2]s"]%[1]s;
  way["natural"="water"]%[1]s;
  relation["natural"="water"]%[1]s;
  way["waterway"="riverbank"]%[1]s;
  relation["waterway"="riverbank"]%[1]s;
  way["landuse"="reservoir"]%[1]s;
  relation["landuse"="reservoir"]%[1]s;
  way["leisure"~"%[3]s"]%[1]s;
  relation["leisure"~"%[3]s"]%[1]s;
  way["landuse"~"%[4]s"]%[1]s;
  relation["landuse"~"%[4]s"]%[1]s;
  way["natural"~"%[5]s"]%[1]s;
  relation["natural"~"%[5]s"]%[1]s;
  way["place"="square"]%[1]s;
  way["amenity"="parking"]%[1]s;
  way["natural"="tree_row"]%[1]s;
  node["natural"="tree"]%[1]s;
  node["historic"~"%[6]s"]%[1]s;
  way["historic"~"%[6]s"]%[1]s;
  relation["historic"~"%[6]s"]%[1]s;
  node["tourism"="artwork"]["artwork_type"~"%[7]s"]%[1]s;
  way["tourism"="artwork"]["artwork_type"~"%[7]s"]%[1]s;
  relation["tourism"="artwork"]["artwork_type"~"%[7]s"]%[1]s;
  node["amenity"="fountain"]%[1]s;
  way["amenity"="fountain"]%[1]s;
  relation["amenity"="fountain"]%[1]s;
  way["barrier"~"%[8]s"]%[1]s;
  node["amenity"~"^(bench|waste_basket)$"]%[1]s;
  node["highway"="bus_stop"]%[1]s;
);
out geom;`, bb, rail, leisure, landuse, natural, landmarkKinds, artworkKinds, barriers)
}

// surroundingsQuery fetches buildings across the requested far box and the other context
// features within the smaller context box.
func surroundingsQuery(far, context geo.BBox) string {
	farBB := bboxStr(far)
	contextBB := bboxStr(context)
	rail := alt(railKinds)
	leisure := alt(greenLeisure)
	landuse := alt(greenLanduse)
	natural := alt(greenNatural)
	landmarkKinds := alt([]string{"memorial", "monument"})
	artworkKinds := alt([]string{"statue", "sculpture"})
	barriers := alt(barrierKinds)
	return fmt.Sprintf(`[out:json][timeout:60];
(
  way["building"]%[1]s;
  relation["building"]%[1]s;
  way["building:part"]%[1]s;
  relation["building:part"]%[1]s;
  way["highway"]%[2]s;
  way["railway"~"%[3]s"]%[2]s;
  way["natural"="water"]%[2]s;
  relation["natural"="water"]%[2]s;
  way["waterway"="riverbank"]%[2]s;
  relation["waterway"="riverbank"]%[2]s;
  way["landuse"="reservoir"]%[2]s;
  relation["landuse"="reservoir"]%[2]s;
  way["leisure"~"%[4]s"]%[2]s;
  relation["leisure"~"%[4]s"]%[2]s;
  way["landuse"~"%[5]s"]%[2]s;
  relation["landuse"~"%[5]s"]%[2]s;
  way["natural"~"%[6]s"]%[2]s;
  relation["natural"~"%[6]s"]%[2]s;
  way["place"="square"]%[2]s;
  way["amenity"="parking"]%[2]s;
  way["natural"="tree_row"]%[2]s;
  node["natural"="tree"]%[2]s;
  node["historic"~"%[7]s"]%[2]s;
  way["historic"~"%[7]s"]%[2]s;
  relation["historic"~"%[7]s"]%[2]s;
  node["tourism"="artwork"]["artwork_type"~"%[8]s"]%[2]s;
  way["tourism"="artwork"]["artwork_type"~"%[8]s"]%[2]s;
  relation["tourism"="artwork"]["artwork_type"~"%[8]s"]%[2]s;
  node["amenity"="fountain"]%[2]s;
  way["amenity"="fountain"]%[2]s;
  relation["amenity"="fountain"]%[2]s;
  way["barrier"~"%[9]s"]%[2]s;
);
out geom;`, farBB, contextBB, rail, leisure, landuse, natural, landmarkKinds, artworkKinds, barriers)
}
