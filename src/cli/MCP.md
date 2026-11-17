# MCP server

Present in the code, not part of the 0.1.0 release. Experimental.

`sep mcp` is an MCP server on stdio (no network listener); `sep mcp --port 8471` serves Streamable HTTP on 127.0.0.1 only: every request needs `Authorization: Bearer <token>` (a new random token each start, printed to stderr and written to `~/.separation-table/mcp-8471.token`, mode 0600), a Host of 127.0.0.1, localhost or [::1] with that port, and no foreign Origin. The tools read and write files only under the working directory, or `--root DIR`. A job file's art must sit in the job file's folder or under it (`sep convert --allow-outside` opts out) and match its recorded SHA-256. `--log FILE` keeps a JSONL line per call (off by default).

34 tools, each verb_noun with readOnlyHint and destructiveHint and a batch-safe flag: separate_art, load_art, open_file, set_options, use_profile, separate, get_job, get_separation, check_job, explain_check, show_region, preview_print, preview_film, set_screen, add_screen, remove_screen, move_screen, order_screens, reduce_screens, clean_screens, double_hit_screen, set_print_size, vectorize_screen, list_inks, list_profiles, list_garments, list_jobs, switch_job, new_job, undo, save_job, export_job, send_to_rip, batch. Arguments a tool does not take, or of the wrong type, are refused with the ones it takes; a wrong screen or ink name lists the real ones (screens by print order, ink name, film name or file slug). Every tool that changes the job takes `terse`, and each call is one undo step. Tools that write a file refuse to write over one without `overwrite: true`. `batch` runs up to 64 calls all or nothing, with `$N.field` references to earlier results.

```bash
claude mcp add separation-table -- node "$PWD/src/cli/sep.mjs" mcp
```

Try asking:

> Separate ~/art/eagle.png for a black shirt, 12 inches wide, on our automatic press. Check it, show me where any check is, and if one screen covers almost nothing, see what dropping it costs before you do. Save the job, then put the films in ~/rip/hot.
