package coords

import (
	"archive/zip"
	"bytes"
	"errors"
	"math"
	"testing"
)

// buildKMZ returns a zip archive holding the given entries, written in the given order.
func buildKMZ(t *testing.T, entries [][2]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		w, err := zw.Create(e[0])
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(e[1])); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

const kmlPoint = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>Shibuya Crossing</name>
      <Point><coordinates>139.7005,35.6595,0</coordinates></Point>
    </Placemark>
  </Document>
</kml>`

const kmlLookAtAfterPoint = `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>First point</name><Point><coordinates> 10.5,20.25 </coordinates></Point></Placemark>
  <Placemark><name>View</name><LookAt><longitude>139.7005</longitude><latitude>35.6595</latitude><heading>45</heading><tilt>60</tilt><range>500</range></LookAt></Placemark>
</Document></kml>`

const kmlLookAtFirst = `<kml><Document>
  <Folder><name>Camera folder</name>
    <Placemark><LookAt><longitude>139.7005</longitude><latitude>35.6595</latitude><heading>-30.5</heading></LookAt></Placemark>
  </Folder>
  <Placemark><name>Later</name><Point><coordinates>1,2</coordinates></Point></Placemark>
</Document></kml>`

const kmlInvalidThenValid = `<kml><Document>
  <Placemark><name>Off the map</name><Point><coordinates>400,95,0</coordinates></Point></Placemark>
  <Placemark><name>Tokyo</name><Point><coordinates>139.7005,35.6595</coordinates></Point></Placemark>
</Document></kml>`

const kmlNoLocation = `<kml><Document><Placemark><name>Lines only</name><LineString><coordinates>1,2 3,4</coordinates></LineString></Placemark></Document></kml>`

func TestParseFileKML(t *testing.T) {
	tests := []struct {
		name     string
		xml      string
		lat, lon float64
		heading  *float64
		tilt     *float64
		label    string
	}{
		{name: "point with name", xml: kmlPoint, lat: 35.6595, lon: 139.7005, label: "Shibuya Crossing"},
		{name: "first point in document order wins over a later LookAt", xml: kmlLookAtAfterPoint,
			lat: 20.25, lon: 10.5, label: "First point"},
		{name: "LookAt first, with heading and tilt", xml: kmlLookAtFirst,
			lat: 35.6595, lon: 139.7005, heading: f64(-30.5), label: "Camera folder"},
		{name: "invalid coordinates are skipped", xml: kmlInvalidThenValid,
			lat: 35.6595, lon: 139.7005, label: "Tokyo"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseFile("doc.kml", []byte(tc.xml))
			if err != nil {
				t.Fatal(err)
			}
			if math.Abs(got.Lat-tc.lat) > 1e-9 || math.Abs(got.Lon-tc.lon) > 1e-9 {
				t.Fatalf("got (%v, %v), want (%v, %v)", got.Lat, got.Lon, tc.lat, tc.lon)
			}
			if !sameOptional(got.Heading, tc.heading, 1e-9) {
				t.Errorf("heading = %v, want %v", got.Heading, tc.heading)
			}
			if !sameOptional(got.Tilt, tc.tilt, 1e-9) {
				t.Errorf("tilt = %v, want %v", got.Tilt, tc.tilt)
			}
			if got.Name != tc.label {
				t.Errorf("name = %q, want %q", got.Name, tc.label)
			}
		})
	}
}

func TestParseFileKMLLookAtWithTiltAndHeading(t *testing.T) {
	got, err := ParseFile("view.kml", []byte(kmlLookAtAfterPoint))
	if err != nil {
		t.Fatal(err)
	}
	// The first Point wins, so the LookAt values must not leak into it.
	if got.Heading != nil || got.Tilt != nil {
		t.Fatalf("Point result carries camera values: %+v", got)
	}

	view := `<kml><Document><Placemark><name>View</name><LookAt><longitude>139.7005</longitude><latitude>35.6595</latitude><heading>45</heading><tilt>60</tilt></LookAt></Placemark></Document></kml>`
	got, err = ParseFile("view.kml", []byte(view))
	if err != nil {
		t.Fatal(err)
	}
	if got.Heading == nil || *got.Heading != 45 || got.Tilt == nil || *got.Tilt != 60 || got.Name != "View" {
		t.Fatalf("LookAt result = %+v", got)
	}
}

func TestParseFileKMLErrors(t *testing.T) {
	if _, err := ParseFile("empty.kml", []byte(kmlNoLocation)); !errors.Is(err, ErrNoLocation) {
		t.Fatalf("no-point KML: err = %v, want ErrNoLocation", err)
	}
	if _, err := ParseFile("broken.kml", []byte("<kml><Document>")); err == nil {
		t.Fatal("truncated KML must fail")
	}
}

func TestParseFileKMZ(t *testing.T) {
	kmz := buildKMZ(t, [][2]string{
		{"files/icon.png", "not really a png"},
		{"doc.kml", kmlPoint},
	})
	got, err := ParseFile("places.kmz", kmz)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(got.Lat-35.6595) > 1e-9 || math.Abs(got.Lon-139.7005) > 1e-9 || got.Name != "Shibuya Crossing" {
		t.Fatalf("KMZ result = %+v", got)
	}

	// Detected by the zip signature even with a misleading name.
	got, err = ParseFile("download", kmz)
	if err != nil || math.Abs(got.Lat-35.6595) > 1e-9 {
		t.Fatalf("zip signature detection: %+v, %v", got, err)
	}
}

func TestParseFileKMZErrors(t *testing.T) {
	noKML := buildKMZ(t, [][2]string{{"readme.txt", "nothing here"}})
	if _, err := ParseFile("empty.kmz", noKML); !errors.Is(err, ErrNoLocation) {
		t.Fatalf("archive without KML: err = %v, want ErrNoLocation", err)
	}
	if _, err := ParseFile("bad.kmz", []byte("definitely not a zip")); err == nil {
		t.Fatal("non-zip KMZ must fail")
	}
}

const geoJSONPolygonFirst = `{
  "type": "FeatureCollection",
  "features": [
    {"type": "Feature", "properties": {"name": "Square block"},
     "geometry": {"type": "Polygon", "coordinates": [[
       [139.70, 35.65], [139.71, 35.65], [139.71, 35.66], [139.70, 35.66], [139.70, 35.65]
     ]]}},
    {"type": "Feature", "properties": {"title": "Station"},
     "geometry": {"type": "Point", "coordinates": [139.7005, 35.6595]}}
  ]
}`

func TestParseFileGeoJSON(t *testing.T) {
	tests := []struct {
		name     string
		file     string
		data     string
		lat, lon float64
		label    string
	}{
		{
			name: "first point wins over an earlier polygon",
			file: "stations.geojson", data: geoJSONPolygonFirst,
			lat: 35.6595, lon: 139.7005, label: "Station",
		},
		{
			name: "polygon bbox centre when there is no point",
			file: "block.json",
			data: `{"type":"Feature","properties":{"name":"Square block"},"geometry":{"type":"Polygon","coordinates":[[[139.70,35.65],[139.71,35.65],[139.71,35.66],[139.70,35.66],[139.70,35.65]]]}}`,
			lat:  35.655, lon: 139.705, label: "Square block",
		},
		{
			name: "upper case extension and geometry collection",
			file: "MIXED.JSON",
			data: `{"type":"GeometryCollection","name":"Bundle","geometries":[{"type":"LineString","coordinates":[[139.0,35.0],[141.0,37.0]]}]}`,
			lat:  36.0, lon: 140.0, label: "Bundle",
		},
		{
			name: "bare point geometry",
			file: "p.geojson",
			data: `{"type":"Point","coordinates":[139.7005,35.6595]}`,
			lat:  35.6595, lon: 139.7005,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseFile(tc.file, []byte(tc.data))
			if err != nil {
				t.Fatal(err)
			}
			if math.Abs(got.Lat-tc.lat) > 1e-9 || math.Abs(got.Lon-tc.lon) > 1e-9 {
				t.Fatalf("got (%v, %v), want (%v, %v)", got.Lat, got.Lon, tc.lat, tc.lon)
			}
			if got.Name != tc.label {
				t.Fatalf("name = %q, want %q", got.Name, tc.label)
			}
		})
	}
}

func TestParseFileGeoJSONErrors(t *testing.T) {
	if _, err := ParseFile("bad.geojson", []byte(`{"type": `)); err == nil {
		t.Fatal("invalid JSON must fail")
	}
	empty := `{"type":"FeatureCollection","features":[]}`
	if _, err := ParseFile("empty.geojson", []byte(empty)); !errors.Is(err, ErrNoLocation) {
		t.Fatalf("empty collection: err = %v, want ErrNoLocation", err)
	}
	outOfRange := `{"type":"Point","coordinates":[500,95]}`
	if _, err := ParseFile("far.geojson", []byte(outOfRange)); !errors.Is(err, ErrNoLocation) {
		t.Fatalf("out of range point: err = %v, want ErrNoLocation", err)
	}
}
