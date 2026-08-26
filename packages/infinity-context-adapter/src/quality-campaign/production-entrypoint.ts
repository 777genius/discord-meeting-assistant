#!/usr/bin/env -S node --import tsx/esm

import { runQualityCampaignProductionCli } from "./production-cli.js";

process.exitCode = await runQualityCampaignProductionCli({ argv: process.argv.slice(2),
  writeSafeLine: (line) => {process.stdout.write(`${line}\n`);} });
