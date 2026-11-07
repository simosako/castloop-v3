export function showTemplate(id: string): string {
  return `# Fill in publication fields before setting publish = true.\nschema_version = 1\nid = "${id}"\npublish = false\ntitle = ""\ndescription = ""\nwebsite = ""\nlanguage = "ja"\nauthor = ""\nartwork = "cover.jpg"\ncategories = []\nexplicit = false\ntimezone = "Asia/Tokyo"\ntype = "episodic"\n`;
}

export function episodeTemplate(showId: string, id: string): string {
  return `# Add published_at as a TOML datetime; the show's timezone is the default.\nschema_version = 1\nid = "${id}"\nshow_id = "${showId}"\npublish = false\ntitle = ""\ndescription = ""\n# published_at = 2026-01-01T12:00:00\nepisode_type = "full"\n`;
}
