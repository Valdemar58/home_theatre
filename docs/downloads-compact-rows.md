# Downloads: compact title rows

The shared web/desktop page selects one storage location rather than nesting server storage and source queues inside device downloads. Each location shows one disk chart; multiple filesystems use a disk selector.

Title summaries follow the existing online-viewing row: cover, title, compact metadata, a byte-weighted season progress bar and a short `Серии · N` disclosure. Expanded episodes are vertical rows with full file size, 80/20 download/preparation progress and per-copy deletion. Occupancy remains actual stored bytes including prepared derivatives. Viewer details appear on hover/focus rather than as additional disclosures.

Server stream episodes incorporate their prepared copies. Those copies are excluded from the standalone prepared-title list, preserving management of copies whose original stream was removed. Jellyfin links and folder captions have been removed from this screen. Server and desktop transfer APIs, confirmations and in-use deletion protection remain in place.

Addition dates for desktop jobs come from acknowledged inspect commands and persist in reported snapshots after command cleanup. Existing jobs with no retained creation record keep an unknown date; heartbeat time is never presented as addition time. Stream file sizes come from available torrent metadata, prepared-file records or active preparation. Unknown sizes are explicit.

Validation: TypeScript; production Docker build; desktop command tests (including addition-date persistence); browser review of actual shared inventory components with two titles, 25 episodes, two disks and long titles at desktop and 390px. Confirmed expansion, deletion confirmation and disabled deletion while preparing. Review data was synthetic; no real media was deleted. The temporary review route was removed before building the deployed image.
