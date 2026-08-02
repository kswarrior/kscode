package web

import "embed"

//go:embed all:dist
var files embed.FS

// FS returns the embedded frontend filesystem rooted at dist.
func FS() embed.FS {
	return files
}
