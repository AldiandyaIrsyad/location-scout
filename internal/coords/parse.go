package coords

import (
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Port of parseLocation() and decodeOlc() in web/js/coords.js. Formats are tried in the same order:
// Google Maps place pin, "@lat,lon" (with Google Earth tokens), ?q=/ll=/center=, OpenStreetMap,
// decimal, DMS/DM, full Plus Code.

const (
	olcAlphabet = "23456789CFGHJMPQRVWX"
	num         = `-?\d+(?:\.\d+)?`
)

var (
	reGooglePin   = regexp.MustCompile(`!3d(` + num + `)!4d(` + num + `)`)
	reAtCoords    = regexp.MustCompile(`@(` + num + `),(` + num + `)((?:,` + num + `[a-zA-Z])*)`)
	reAtToken     = regexp.MustCompile(`^(-?\d+(?:\.\d+)?)([a-zA-Z])$`)
	reQueryParam  = regexp.MustCompile(`(?i)[?&](?:q|ll|center|query|daddr|saddr)=(` + num + `),\s*(` + num + `)`)
	reSearchPath  = regexp.MustCompile(`/search/(` + num + `),\s*(` + num + `)`)
	reOSMMap      = regexp.MustCompile(`map=\d+(?:\.\d+)?/(` + num + `)/(` + num + `)`)
	reOSMMLat     = regexp.MustCompile(`mlat=(` + num + `)`)
	reOSMMLon     = regexp.MustCompile(`mlon=(` + num + `)`)
	reDecimal     = regexp.MustCompile(`^\s*(` + num + `)\s*°?\s*([NSns])?\s*[,;\s]\s*(` + num + `)\s*°?\s*([EWew])?\s*$`)
	reDMS         = regexp.MustCompile(`(-?\d{1,3}(?:\.\d+)?)\s*°\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′’]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*(?:"|″|”|′′|'')\s*)?([NSEWnsew])?`)
	rePlusCode    = regexp.MustCompile(`([` + olcAlphabet + `]{8})\+([` + olcAlphabet + `]{2})`)
	rePrefixFloat = regexp.MustCompile(`^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`)
)

// Parse reads a location from free-form user input: a map link, coordinates in decimal or
// degrees/minutes/seconds form, or a full Open Location Code. It reports false when nothing matches.
func Parse(text string) (*Location, bool) {
	s := safeUnescape(strings.TrimSpace(text))
	if s == "" {
		return nil, false
	}
	parsers := []func(string) (*Location, bool){
		parseGooglePin,
		parseAtCoords,
		parseQueryCoords,
		parseOSMURL,
		parseDecimal,
		parseDMS,
		parsePlusCode,
	}
	for _, parse := range parsers {
		if loc, ok := parse(s); ok {
			return loc, true
		}
	}
	return nil, false
}

// DecodeOLC decodes a full Open Location Code (with or without '+') to the centre of its cell.
// Digits 1 to 10 are five lat/lon pairs (resolutions 20, 1, 0.05, 0.0025 and 0.000125 degrees);
// further digits refine the cell on a 5-row by 4-column grid.
func DecodeOLC(code string) (lat, lon float64, ok bool) {
	digits := strings.Replace(strings.ToUpper(code), "+", "", 1)
	if len(digits) < 10 {
		return 0, 0, false
	}
	pairRes := [5]float64{20, 1, 0.05, 0.0025, 0.000125}
	lat, lon = -90, -180
	for p := 0; p < 5; p++ {
		iLat := strings.IndexByte(olcAlphabet, digits[2*p])
		iLon := strings.IndexByte(olcAlphabet, digits[2*p+1])
		if iLat < 0 || iLon < 0 {
			return 0, 0, false
		}
		lat += float64(iLat) * pairRes[p]
		lon += float64(iLon) * pairRes[p]
	}
	cellLat, cellLon := 0.000125, 0.000125
	for k := 10; k < len(digits); k++ {
		v := strings.IndexByte(olcAlphabet, digits[k])
		if v < 0 {
			return 0, 0, false
		}
		cellLat /= 5
		cellLon /= 4
		lat += float64(v/4) * cellLat
		lon += float64(v%4) * cellLon
	}
	return lat + cellLat/2, lon + cellLon/2, true
}

// safeUnescape decodes percent-escapes, returning the input unchanged when they are malformed.
func safeUnescape(s string) string {
	out, err := url.PathUnescape(s)
	if err != nil {
		return s
	}
	return out
}

func isValidLatLon(lat, lon float64) bool {
	return isFinite(lat) && isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
}

func isFinite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}

// latLon returns the location when the pair is a valid latitude and longitude.
func latLon(lat, lon float64) (*Location, bool) {
	if !isValidLatLon(lat, lon) {
		return nil, false
	}
	return &Location{Lat: lat, Lon: lon}, true
}

// mustFloat parses a string already matched by num; it cannot fail for those matches.
func mustFloat(s string) float64 {
	v, _ := strconv.ParseFloat(s, 64)
	return v
}

// parseFloatPrefix mirrors JavaScript parseFloat: leading whitespace is skipped and the longest
// numeric prefix is used. ok is false when there is no number.
func parseFloatPrefix(s string) (float64, bool) {
	s = strings.TrimLeft(s, " \t\r\n\f\v")
	m := rePrefixFloat.FindString(s)
	if m == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(m, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

func parseGooglePin(s string) (*Location, bool) {
	m := reGooglePin.FindStringSubmatch(s)
	if m == nil {
		return nil, false
	}
	return latLon(mustFloat(m[1]), mustFloat(m[2]))
}

// parseAtCoords reads "@lat,lon" followed by optional suffixed tokens used by Google Earth and Street View:
// <n>h heading, <n>t tilt, <n>d range in meters. Altitude (a), fov (y), roll (r) and zoom (z) are ignored.
func parseAtCoords(s string) (*Location, bool) {
	m := reAtCoords.FindStringSubmatch(s)
	if m == nil {
		return nil, false
	}
	loc, ok := latLon(mustFloat(m[1]), mustFloat(m[2]))
	if !ok {
		return nil, false
	}
	for _, tok := range strings.Split(m[3], ",") {
		t := reAtToken.FindStringSubmatch(tok)
		if t == nil {
			continue
		}
		v := mustFloat(t[1])
		switch strings.ToLower(t[2]) {
		case "h":
			loc.Heading = &v
		case "t":
			loc.Tilt = &v
		case "d":
			loc.Range = &v
		}
	}
	return loc, true
}

func parseQueryCoords(s string) (*Location, bool) {
	m := reQueryParam.FindStringSubmatch(s)
	if m == nil {
		m = reSearchPath.FindStringSubmatch(s)
	}
	if m == nil {
		return nil, false
	}
	return latLon(mustFloat(m[1]), mustFloat(m[2]))
}

func parseOSMURL(s string) (*Location, bool) {
	if m := reOSMMap.FindStringSubmatch(s); m != nil {
		if loc, ok := latLon(mustFloat(m[1]), mustFloat(m[2])); ok {
			return loc, true
		}
	}
	la := reOSMMLat.FindStringSubmatch(s)
	lo := reOSMMLon.FindStringSubmatch(s)
	if la != nil && lo != nil {
		return latLon(mustFloat(la[1]), mustFloat(lo[1]))
	}
	return nil, false
}

// parseDecimal reads a whole-string pair such as "35.6595, 139.7005", "35.6595 139.7005" or
// "35.6595N 139.7005E". Hemisphere letters negate the value.
func parseDecimal(s string) (*Location, bool) {
	m := reDecimal.FindStringSubmatch(s)
	if m == nil {
		return nil, false
	}
	lat := mustFloat(m[1])
	lon := mustFloat(m[3])
	if m[2] != "" && strings.EqualFold(m[2], "S") {
		lat = -math.Abs(lat)
	}
	if m[4] != "" && strings.EqualFold(m[4], "W") {
		lon = -math.Abs(lon)
	}
	return latLon(lat, lon)
}

// parseDMS reads exactly two degree(-minute)(-second) values, such as 35°39'34.2"N 139°42'01.8"E or
// 35°39.57'N 139°42.03'E. Hemisphere letters decide which value is latitude when they are given.
func parseDMS(s string) (*Location, bool) {
	if !strings.Contains(s, "°") {
		return nil, false
	}
	type coord struct {
		mag float64
		neg bool
		hem string
	}
	var found []coord
	for _, m := range reDMS.FindAllStringSubmatch(s, -1) {
		deg := mustFloat(m[1])
		var mins, secs float64
		if m[2] != "" {
			mins = mustFloat(m[2])
		}
		if m[3] != "" {
			secs = mustFloat(m[3])
		}
		if mins >= 60 || secs >= 60 {
			return nil, false
		}
		found = append(found, coord{
			mag: math.Abs(deg) + mins/60 + secs/3600,
			neg: strings.HasPrefix(m[1], "-"),
			hem: strings.ToUpper(m[4]),
		})
	}
	if len(found) != 2 {
		return nil, false
	}
	p1, p2 := found[0], found[1]
	// E or W cannot be the latitude, and N or S cannot be the longitude: swap when the letters say so.
	if p1.hem == "E" || p1.hem == "W" || p2.hem == "N" || p2.hem == "S" {
		p1, p2 = p2, p1
	}
	signed := func(c coord) float64 {
		if c.neg || c.hem == "S" || c.hem == "W" {
			return -c.mag
		}
		return c.mag
	}
	return latLon(signed(p1), signed(p2))
}

// parsePlusCode finds a full Open Location Code: 8 characters, '+', then 2 characters, not followed by
// another code character. Short codes are not supported.
func parsePlusCode(s string) (*Location, bool) {
	up := strings.ToUpper(s)
	for _, idx := range rePlusCode.FindAllStringSubmatchIndex(up, -1) {
		end := idx[1]
		if end < len(up) && strings.IndexByte(olcAlphabet, up[end]) >= 0 {
			continue // the match is part of a longer run of code characters
		}
		code := up[idx[2]:idx[3]] + up[idx[4]:idx[5]]
		lat, lon, ok := DecodeOLC(code)
		if !ok {
			return nil, false
		}
		return latLon(lat, lon)
	}
	return nil, false
}
