## Design Context

### Users
Primary: Field sales reps using the app on mobile — in cars between client visits, at customer offices, checking in and out of visits, updating deal progress on the go. Speed and legibility in variable light conditions (car interior, outdoor glare, office lobbies) are critical. Secondary: Sales managers and admins on desktop, reviewing dashboards, configuring master data, monitoring team performance.

Usage pattern: High-frequency, short sessions on mobile (quick task completion — check in, log a visit, move a deal stage). Longer focused sessions on desktop.

### Brand Personality
Three words: **Professional. Motivational. Fun.**

The interface should feel like a premium sports performance tool — the kind of product reps are *proud* to pull out in front of a client. Not corporate drudgery. Not startup-cute. Think precision meets energy: like a high-end sports watch UI or an F1 pit display — sharp data, fast reads, quietly exciting. It should make a rep feel like they're *winning*, not doing admin work.

### Aesthetic Direction
- **Theme**: Auto light/dark based on system `prefers-color-scheme`. Light for daytime field use (high readability in sun/office environments). Dark for evening desktop sessions.
- **Accent**: ClickUp purple (`oklch(60% 0.23 278)`) — vivid, confident, instantly recognisable. Pairs well with both light and dark surfaces.
- **Neutrals**: Tinted warm (slightly amber-hued) — never pure white or pure black. Surfaces feel warm and tactile, not clinical.
- **Reference**: ClickUp — specifically its information density done right (lots of data but clear visual hierarchy), its use of color for status and priority (not decoration), and the way it makes power users feel in control without overwhelming newcomers. The sidebar + content layout, the way it uses chips/tags for deal stages, and its generally energetic but purposeful feel are all strong models.
- **Anti-references**: Nothing that looks like Salesforce bloat, generic enterprise SaaS grids, or startup glassmorphism.
- **Typography**: Barlow (display/headings — condensed for big metrics, impact numbers, kanban headers) + Figtree (body/UI — warm, geometric, highly legible at small sizes on mobile).

### Design Principles
1. **Speed over ceremony** — every screen should be scannable in under 3 seconds. Reps don't have time to hunt.
2. **Earn the accent** — amber is rare, purposeful: active states, wins, CTAs. Not decoration.
3. **Achievement-first hierarchy** — KPI numbers, deal counts, visit progress are the heroes of every view. Labels are secondary.
4. **Feels like a tool, not a form** — interactions are direct and tactile. Taps feel immediate. Data entry is minimal.
5. **Consistent across light and dark** — the same information hierarchy, same visual weight. Theme switches, character doesn't.
