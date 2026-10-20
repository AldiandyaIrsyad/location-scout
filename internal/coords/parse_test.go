package coords

import (
	"math"
	"testing"
)

func f64(v float64) *float64 { return &v }

// sameOptional reports whether got and want are both nil or hold values within tol.
func sameOptional(got, want *float64, tol float64) bool {
	if got == nil || want == nil {
		return got == nil && want == nil
	}
	return math.Abs(*got-*want) <= tol
}

func TestParse(t *testing.T) {
	const shibuyaLat, shibuyaLon = 35.6595, 139.7005
	tests := []struct {
		name     string
		in       string
		ok       bool
		lat, lon float64
		heading  *float64
		tilt     *float64
		rng      *float64
	}{
		// Google Maps
		{
			name: "google maps place pin",
			in:   "https://www.google.com/maps/place/Shibuya+Crossing/@35.6595,139.7005,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d35.6595!4d139.7005",
			ok:   true, lat: shibuyaLat, lon: shibuyaLon,
		},
		{
			name: "google maps @ coordinates",
			in:   "https://www.google.com/maps/@35.6595,139.7005,17z",
			ok:   true, lat: shibuyaLat, lon: shibuyaLon,
		},
		{
			name: "google earth with heading, tilt and range",
			in:   "https://earth.google.com/web/@35.6595,139.7005,500a,1200d,35y,20h,60t,0r",
			ok:   true, lat: shibuyaLat, lon: shibuyaLon,
			heading: f64(20), tilt: f64(60), rng: f64(1200),
		},
		{
			name: "street view pitch token is tilt",
			in:   "https://www.google.com/maps/@35.6595,139.7005,3a,75y,90t/data=!3m6",
			ok:   true, lat: shibuyaLat, lon: shibuyaLon,
			tilt: f64(90),
		},
		{
			name: "google maps q parameter",
			in:   "https://maps.google.com/?q=35.6595,139.7005",
			ok:   true, lat: shibuyaLat, lon: shibuyaLon,
		},
		{
			name: "google maps ll parameter with negative values",
			in:   "https://maps.google.com/?ll=-33.8568,151.2153",
			ok:   true, lat: -33.8568, lon: 151.2153,
		},
		{
			name: "directions daddr",
			in:   "https://www.google.com/maps/dir/?api=1&daddr=35.6595,139.7005",
			ok:   true, lat: shibuyaLat, lon: shibuyaLon,
		},
		// OpenStreetMap
		{
			name: "osm map fragment",
			in:   "https://www.openstreetmap.org/#map=17/35.6595/139.7005",
			ok:   true, lat: shibuyaLat, lon: shibuyaLon,
		},
		{
			name: "osm mlat and mlon",
			in:   "https://www.openstreetmap.org/?mlat=35.6595&mlon=139.7005",
			ok:   true, lat: shibuyaLat, lon: shibuyaLon,
		},
		// Decimal
		{name: "decimal comma", in: "35.6595, 139.7005", ok: true, lat: shibuyaLat, lon: shibuyaLon},
		{name: "decimal space", in: "35.6595 139.7005", ok: true, lat: shibuyaLat, lon: shibuyaLon},
		{name: "decimal with hemisphere letters", in: "35.6595N 139.7005E", ok: true, lat: shibuyaLat, lon: shibuyaLon},
		{name: "decimal south west", in: "35.6595S, 139.7005W", ok: true, lat: -shibuyaLat, lon: -shibuyaLon},
		{name: "decimal surrounded by spaces", in: "  35.6595,139.7005  ", ok: true, lat: shibuyaLat, lon: shibuyaLon},
		{name: "decimal out of range", in: "100, 200", ok: false},
		// DMS and DM
		{name: "dms", in: `35°39'34.2"N 139°42'01.8"E`, ok: true, lat: shibuyaLat, lon: shibuyaLon},
		{name: "dms lon first", in: `139°42'01.8"E 35°39'34.2"N`, ok: true, lat: shibuyaLat, lon: shibuyaLon},
		{name: "dm minutes with decimals", in: `35°39.57'N 139°42.03'E`, ok: true, lat: shibuyaLat, lon: shibuyaLon},
		{name: "dms south west", in: `35°39'34.2"S 139°42'01.8"W`, ok: true, lat: -shibuyaLat, lon: -shibuyaLon},
		{name: "dms minutes out of range", in: `35°70'00"N 139°00'00"E`, ok: false},
		{name: "single dms value", in: `35°39'34.2"N`, ok: false},
		// Plus codes
		{name: "full plus code", in: "849VCWC8+R9", ok: true, lat: 37.42206, lon: -122.08406},
		{name: "plus code in sentence", in: "Meet at 849VCWC8+R9 by the bridge", ok: true, lat: 37.42206, lon: -122.08406},
		{name: "plus code lower case", in: "849vcwc8+r9", ok: true, lat: 37.42206, lon: -122.08406},
		// Rejects
		{name: "empty", in: "", ok: false},
		{name: "text", in: "hello world", ok: false},
		{name: "latitude too large", in: "91, 0", ok: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := Parse(tc.in)
			if ok != tc.ok {
				t.Fatalf("Parse(%q) ok = %v, want %v (got %+v)", tc.in, ok, tc.ok, got)
			}
			if !ok {
				return
			}
			const tol = 1e-4
			if math.Abs(got.Lat-tc.lat) > tol || math.Abs(got.Lon-tc.lon) > tol {
				t.Fatalf("Parse(%q) = (%.6f, %.6f), want (%.6f, %.6f)", tc.in, got.Lat, got.Lon, tc.lat, tc.lon)
			}
			if !sameOptional(got.Heading, tc.heading, 1e-9) {
				t.Errorf("heading = %v, want %v", got.Heading, tc.heading)
			}
			if !sameOptional(got.Tilt, tc.tilt, 1e-9) {
				t.Errorf("tilt = %v, want %v", got.Tilt, tc.tilt)
			}
			if !sameOptional(got.Range, tc.rng, 1e-9) {
				t.Errorf("range = %v, want %v", got.Range, tc.rng)
			}
		})
	}
}

func TestParseGooglePinWinsOverAt(t *testing.T) {
	// The place pin (!3d/!4d) is checked first, so it wins over an @ position in the same URL.
	got, ok := Parse("https://www.google.com/maps/@35.0,135.0,17z/data=!3d35.6595!4d139.7005")
	if !ok || math.Abs(got.Lat-35.6595) > 1e-9 || math.Abs(got.Lon-139.7005) > 1e-9 {
		t.Fatalf("got %+v, ok=%v; want the !3d/!4d pin", got, ok)
	}
}

func TestDecodeOLC(t *testing.T) {
	lat, lon, ok := DecodeOLC("849VCWC8+R9")
	if !ok {
		t.Fatal("DecodeOLC rejected a full code")
	}
	if math.Abs(lat-37.42206) > 1e-4 || math.Abs(lon-(-122.08406)) > 1e-4 {
		t.Fatalf("DecodeOLC = (%.6f, %.6f), want (37.42206, -122.08406)", lat, lon)
	}

	// The centre of the 1/8000 degree cell is 0.000125 / 2 away from the lower corner.
	lat2, lon2, _ := DecodeOLC("849VCWC8+R9")
	if lat2 <= 37.422 || lon2 >= -122.084 {
		t.Fatalf("centre should be inside the cell, got (%v, %v)", lat2, lon2)
	}

	for _, bad := range []string{"849VCWC8", "849VCWC8+R", "", "849VCWC8+R9!"} {
		if _, _, ok := DecodeOLC(bad); ok {
			t.Errorf("DecodeOLC(%q) accepted an invalid code", bad)
		}
	}
	if _, _, ok := DecodeOLC("A49VCWC8+R9"); ok {
		t.Error("DecodeOLC accepted a character outside the alphabet")
	}
}
