## MusiGod — Royalty Earnings Dashboard Build

Project: MusiGod (Supabase project `uykzkrnoetcldeuxzqyy`, us-east-2)
DO NOT TOUCH: `dtcmofpvixbkpwqvecid` (Noterminal — separate project)

Deploy: cd C:\musigod-deploy && vercel --prod --force
Anon key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5a3prcm5vZXRjbGRldXh6cXl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1MzA2MTksImV4cCI6MjA5MzEwNjYxOX0.r4Dx_Jkgje2kYNGh9PQtuyuJgBGJwVAviHM9QmAJcrs

Artist: Naim Salaam (artist_id: 3d4788b6-2a86-4ed5-8f27-ab95b3a230d3)
54 registrations already seeded in registrations.registrations_v1

## Task: Build earnings.html — Royalty Earnings Dashboard

### Step 1 — DB: Create earnings schema and seed mock data

Use apply_migration. Create:

**Table: earnings.royalty_statements_v1**
- id uuid PK default gen_random_uuid()
- artist_id uuid (FK to artists)
- registration_id uuid (FK to registrations.registrations_v1)
- pro text (ASCAP, BMI, SESAC, SOCAN)
- period_start date
- period_end date
- amount_usd numeric(12,2)
- status text (PENDING, PAID)
- statement_date date
- created_at timestamptz default now()

Seed realistic mock data:
- 12 months of history (May 2024 — April 2025)
- Spread across all 54 registrations, not just a few
- 3 PROs: ASCAP, BMI, SESAC (weight ASCAP heaviest ~50%, BMI ~30%, SESAC ~20%)
- Amount per statement: $8 — $2,400 (vary by song, some songs earn much 
  more than others — make ~8 "catalog anchors" that earn 5-10x average)
- Status: all statements older than 60 days = PAID, newer = PENDING
- Total seeded earnings should land between $180,000 — $240,000 all-time

Create views:
- earnings.v_earnings_summary_v1 — total all-time, YTD, this month, 
  pending total, paid total (for artist_id filter)
- earnings.v_earnings_by_song_v1 — sum by registration_id, song title 
  (join registrations), PRO breakdown per song
- earnings.v_earnings_by_pro_v1 — sum by PRO, count of statements, 
  paid vs pending split
- earnings.v_earnings_by_month_v1 — monthly totals for line chart, 
  broken out by PRO

RLS: enable on earnings.royalty_statements_v1, policy allows SELECT 
where artist_id matches auth.uid() OR anon for now (same pattern as portal)

### Step 2 — Build earnings.html

Single page, new file at C:\musigod-deploy\earnings.html
Match the visual style of portal.html exactly (same font, colors, header)
Supabase JS client loaded via CDN — same pattern as portal.html

**Layout — top to bottom:**

1. Header — same as portal.html (MusiGod logo/wordmark, Naim Salaam, 
   nav link back to portal.html)

2. Summary stat cards (4 cards in a row):
   - Total Earnings (all time)
   - YTD Earnings (Jan 1 current year to today)
   - This Month
   - Pending Payout
   All values formatted as USD. Pull from v_earnings_summary_v1.

3. Earnings Over Time — line chart (12 months)
   - X axis: month labels (May 2024 — Apr 2025)
   - Y axis: USD
   - 3 lines: ASCAP, BMI, SESAC (each a different color)
   - Use Chart.js loaded via CDN
   - Pull from v_earnings_by_month_v1

4. PRO Breakdown — horizontal bar chart or donut chart
   - ASCAP / BMI / SESAC share of total earnings
   - Show dollar amount + percentage for each
   - Pull from v_earnings_by_pro_v1

5. Paid vs Pending — simple visual split
   - Two big numbers side by side with a progress bar
   - Pull from v_earnings_summary_v1

6. Earnings by Song table
   - Columns: Song Title | PRO | Total Earned | Status (PAID/PENDING/MIXED)
   - Sortable by Total Earned (default: highest first)
   - Show top 20 rows, with "Show all" toggle
   - Pull from v_earnings_by_song_v1

### Step 3 — Deploy
cd C:\musigod-deploy && vercel --prod --force

### Canon rules
- All DDL via apply_migration (_v1 suffix, versioned)
- Never touch dtcmofpvixbkpwqvecid
- Write earnings.html directly to C:\musigod-deploy\earnings.html
- Do not output full HTML in the terminal