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
	return fmt.Sprintf(`[out:json][timeout:60];
(
  way["building"]%[1]s;
  relation["building"]%[1]s;
  way["building:part"]%[1]s;
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
);
out geom;`, bb, rail, leisure, landuse, natural)
}

// surroundingsQuery fetches building outlines only (same as osm.js surroundingsQuery).
func surroundingsQuery(b geo.BBox) string {
	bb := bboxStr(b)
	return fmt.Sprintf(`[out:json][timeout:60];
(
  way["building"]%[1]s;
  relation["building"]%[1]s;
);
out geom;`, bb)
}
