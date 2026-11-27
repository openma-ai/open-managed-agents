// Command rclone-oma is the pinned rclone binary used by the OMA sandbox
// native storage path. Build it with the same rclone version used by the
// sandbox image so the backend ABI and command-line behavior stay aligned.
package main

import (
	_ "github.com/open-managed-agents/rclone-oma/backend/oma"
	"github.com/rclone/rclone/cmd"
	_ "github.com/rclone/rclone/cmd/all"
	_ "github.com/rclone/rclone/lib/plugin"
)

func main() {
	cmd.Main()
}
