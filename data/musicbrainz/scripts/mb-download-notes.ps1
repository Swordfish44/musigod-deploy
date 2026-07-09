# mb-download-notes.ps1
# Prints instructions for downloading the MusicBrainz data dump.
# Does NOT download anything automatically.
#
# The full dump is large — read the storage warnings before proceeding.

Write-Host ""
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host "  MusicBrainz Dump — Download Instructions (READ FIRST)"     -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "STORAGE WARNINGS:" -ForegroundColor Red
Write-Host "  Full dump compressed:    ~25 GB"
Write-Host "  Full dump extracted:     ~150 GB"
Write-Host "  After Postgres restore:  ~200-300 GB (with indexes)"
Write-Host "  Recommended free space:  350 GB minimum"
Write-Host ""
Write-Host "Current C: free space:" -ForegroundColor Cyan
$drive = Get-PSDrive C
Write-Host "  Free: $([math]::Round($drive.Free / 1GB, 1)) GB"
Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "STEP 1 — Ensure the staging container is running:"
Write-Host "  .\data\musicbrainz\scripts\mb-start.ps1"
Write-Host ""
Write-Host "STEP 2 — Download the latest full dump from MusicBrainz:"
Write-Host "  Official mirror list: https://metabrainz.org/doc/MusicBrainz_Database/Download"
Write-Host "  Download to: C:\musigod-deploy\data\musicbrainz\dumps\"
Write-Host ""
Write-Host "  Recommended: mbdump-derived.tar.bz2 (works + recordings, ~3 GB)"
Write-Host "  Full database: mbdump.tar.bz2 (~25 GB)"
Write-Host ""
Write-Host "  Example using wget (if installed):"
Write-Host "  wget -P data\musicbrainz\dumps\ https://data.metabrainz.org/pub/musicbrainz/data/fullexport/LATEST/mbdump-derived.tar.bz2"
Write-Host ""
Write-Host "STEP 3 — Extract the dump:"
Write-Host "  tar -xjf data\musicbrainz\dumps\mbdump-derived.tar.bz2 -C data\musicbrainz\dumps\"
Write-Host ""
Write-Host "STEP 4 — Restore into staging Postgres:"
Write-Host "  docker cp data\musicbrainz\dumps\mbdump musigod_mb_staging:/mbdump"
Write-Host "  docker exec -it musigod_mb_staging psql -U musicbrainz -d musicbrainz_staging"
Write-Host "    Then inside psql: \i /mbdump/CreateTables.sql"
Write-Host "    Then: \copy <table> FROM '/mbdump/<table>' ..."
Write-Host ""
Write-Host "  (Full restore scripts available at:"
Write-Host "   https://github.com/metabrainz/musicbrainz-server/tree/master/admin/sql)"
Write-Host ""
Write-Host "STEP 5 — Run transform scripts (once restore is validated):"
Write-Host "  To be created under: data\musicbrainz\scripts\"
Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "DO NOT restore into production Supabase." -ForegroundColor Red
Write-Host "DO NOT commit dump files to Git (they are .gitignored)." -ForegroundColor Red
Write-Host "DO NOT proceed past Step 2 without explicit authorization." -ForegroundColor Red
Write-Host ""
Write-Host "See docs\musicbrainz-ingestion-plan.md for full context." -ForegroundColor Cyan
Write-Host ""
