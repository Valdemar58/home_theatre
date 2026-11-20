# Desktop: disks and season moves

The Downloads page and home summary show user devices only. Server disk capacity and legacy server download queues are no longer part of this interface. Existing server files are not deleted by this UI change.

## Storage

Connect a disk by first selecting a detected mounted filesystem volume, with its free/total capacity and existing-library status. Windows uses volume GUIDs; Linux uses filesystem UUIDs. Partitions on one physical drive count as separate volumes. The same action can be requested from the web; the folder picker opens on the selected computer, starting on the chosen volume. The native picker can navigate elsewhere, but a folder on another volume is rejected before registration. Discovery never mounts or unlocks disks.

Only one library is registered per volume. Selecting an already registered volume opens that library, without another picker or another capacity bar. Its folder stays fixed while nonempty. An empty library can be disconnected and connected again with a different folder; disconnect does not delete files. The disconnected state survives restart. A registered volume disappearing or being replaced at its old path prevents writes; relocation to a new mount point is not automated in this version.

Paths stay on the desktop; the server receives opaque storage IDs, folder basenames, drive labels, capacity and media usage. The selected disk filters managed downloads. A user-selected default disk controls future downloads, with explicit per-download target support. Failure to discover volumes is reported and can be retried; it does not silently bind another volume.

Prepared copies of new managed downloads live beside their originals, not in the Electron profile. Existing prepared copies are included when moving the season. Imported originals remain outside managed moves.

## Moves

Select fully downloaded seasons and choose another connected disk in the move dialog. Episode coverage is checked against the title's known episode count, not only the currently selected files. Unknown episode counts, incomplete downloads, active transfers, preparation, active host leases, destination collisions, missing files and insufficient capacity prevent the move. The native process repeats these checks independently of the UI.

The move copies source files and prepared derivatives, verifies complete hashes (including the library's original identity), persists new paths and timestamps, and only then removes old copies. Stable file IDs and content versions preserve device/room permissions. A local journal recovers interrupted copies or completes a verified commit after restart. A disconnected or changed destination does not permit source deletion. Recovery is available in the interface. No recursive filesystem delete is used by the move engine.

Commands and receipts persist across reconnects. Already completed moves and preparation requests are safe to deliver again. Long-running operations still report progress. Episode preparation is available as a quiet icon; fixed action/size columns keep progress bars aligned. Each episode is a compact vertical row, with 80% download / 20% preparation weighting.

Desktop API/queue and host signalling use Electron's Chromium network stack, including existing system proxy/PAC settings, rather than Node's independent HTTP stack. Device requests use bearer authentication with session cookies omitted and redirects rejected. BitTorrent retains its existing direct transport. No system networking settings are changed by this implementation.

## Verification

- Native tests: real torrent/magnet transfers, real FFmpeg, stable volume identity, duplicate/folder-change protection, empty disconnect/reconnect, move/recovery, collision protection, playback protection, receipt replay and reporting while busy.
- Move tests also run between actual Windows C: and D: drives using disposable data.
- Linux native tests and Windows/Linux packaging; actual Arch GUI remains preview.
- Live verification uses a real movie downloaded to desktop storage. No media download is initiated on the server by this verification.
