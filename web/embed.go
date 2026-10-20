// Package web embeds the frontend so the server runs as a single binary. config.StaticDir (dev only)
// serves the same files from disk instead.
package web

import "embed"

// FS holds index.html, the demo page, css/ and js/. Paths are relative to this directory.
//
//go:embed index.html embed-demo.html css js
var FS embed.FS
