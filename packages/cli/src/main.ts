#!/usr/bin/env bun
import { Command } from "commander";
import { initWorkspace, newEpisode, newShow } from "./workspace";

const program = new Command();
program.name("castloop").description("Manage and publish podcasts on Cloudflare (under development)").version("0.0.0-dev");
program.command("init").description("Initialize a local workspace").action(async () => {
  await initWorkspace(process.cwd());
  console.log("Initialized workspace.");
});
program.command("show").description("Manage shows").command("new").description("Create a local show draft").action(async () => {
  const id = await newShow(process.cwd());
  console.log(`Created ${id}/show.toml`);
});
program.command("episode").description("Manage episodes").command("new <show>").description("Create a local episode draft").action(async (show: string) => {
  const id = await newEpisode(process.cwd(), show);
  console.log(`Created ${show}/${id}/episode.toml`);
});

try { await program.parseAsync(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
