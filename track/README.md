# UnderTheBlock Track

A live field dashboard for a micro-freight block. Follow a package from the loading dock, down the dock lift, along a one-lane service trench under the plaza (the *stratum*), to one of four tenant buildings. The app tells you where it is, when it should arrive, and how sure it is.

ARC 327R · Architecture & Computation · A3 "The Instrument" · Micah Reese

**Open the app:** [mhreese1-source.github.io/UnderTheBlock/track/](https://mhreese1-source.github.io/UnderTheBlock/track/) · part of the [Under the Block project site](../README.md)
One self-contained `index.html`. No install, no build step, and it works offline (fonts fall back to system fonts).

---

## What you can do

| Tab | What it shows |
|---|---|
| **Track** | Plan map of the block. Order a package to Tenant A–D, or tap any robot to follow it. A route line and a pin show exactly where it is (dock pad, dock lift, *Bay P3 · row 13*, *row 9*). Notifications fire when it reaches the dock and waits there, enters the stratum, jams, runs late and is delivered. |
| **Fleet & data** | Every delivery logged: dock arrival, dwell on the dock, time in the stratum, delivery, and the window the app promised. Charts of whether those windows were honest and of deliveries through the day. Little's law checked on the run. CSV export. |
| **How it works** | A plain-language explainer: the journey of one package, carts per day, intermediate scales, floor plenums, and swarming. |

**Controls:** pause and speed, morning-wave or steady arrivals, traffic controller on/off, outgoing mail on/off, unloading *measured* (H-E-B trials) or *instant* (the A2 rule), number of dock crews, *Build bays* (tap a row to add or remove a passing bay), *New day*.

**Unloading (measured).** A delivery reaching the dock waits for a free crew, which opens it, inspects it, pulls it onto the dock and scans it before it joins the line for the lift. Each unload takes one of the four times measured at H-E-B (38 s, 10.3, 11.0 or 11.8 min, steps 1–4 and 7 of trials 1, 2, 4 and 5). The package shows *Arrived* the moment it reaches the dock, then *Crew 2 · unloading*, then the lift.

## How the ETA works

Each ETA comes from running the simulation forward **32 times with fresh randomness** (random arrivals and random pauses in bays).

- The app shows the middle estimate and the range holding 8 in 10 of the futures that deliver.
- It says how many futures jam instead, and gives **no time at all** when every future jams.
- An unload in progress is redrawn in every future from the trials that last longer than it has so far, because the dock cannot know in advance how long it will take.
- **Calibration:** with measured unloading and 3 crews, 78% of packages arrived inside their 80% band over three simulated days (62 of 80), about as wide as claimed. With instant unloading it was 92% (54 of 59).
- The band covers randomness *inside* the model only. Arrival rate and lift speed are assumed, so the real spread is wider.

## What the stratum can carry

Ten random 8-hour shifts per setting at rising steady arrival rates. Ranges run from "no cart ever spills onto the curb" to "the dock queue stays bounded". Days assume 16 operating hours.

| Setting | Carts / hour | Carts / 16-h day |
|---|---|---|
| Two-way traffic, no controller (A2 rules) | 3 | 48 (jams in ~2.7 h at 16/hr) |
| Mail moved to off-hours, no controller | 17–30 | 272–480 |
| **Controller + 10 passing bays (as designed)** | **18–29** | **288–464** |
| Controller + 10 bays + measured unloading, 3 crews | 16–22 | 256–352 |
| Controller + 10 bays + measured unloading, 4 crews | 23–28 | 368–448 |
| Controller + 12 bays | 19–31 | 304–496 |
| Controller + 12 bays + 1-minute dock lift | 39–58 | 624–928 |

- **Bottleneck:** with measured unloading, the dock crews: 8.4 min of dock work per delivery, ~7 an hour per crew, so 1 crew carries 96–112 a day and 3 crews 256–352. The dock lift (one cart every 2 minutes, 30/hr) binds only from 5 crews.
- **Scales:** 1 building 256–464 · 2 buildings 208 · 3 buildings 112 · 4 buildings 48 (all without a controller). Each added building multiplies head-on conflicts in the single lane.
- **Floor plenums:** no. The cart is 1.05 m tall; office raised floors are 41–70 mm deep and data-centre floors 0.8–1.0 m ([Wikipedia, Raised floor](https://en.wikipedia.org/wiki/Raised_floor)).
- **Swarming:** one direction, yes: up to 18 robots in the lane, about 300 carts/hr. Two directions only with bays at all 8 choke points plus the traffic controller.

## Measured, sourced, assumed

| Number | Value | Tag |
|---|---|---|
| Arrivals at the dock | 16 carts/hr peak | assumed |
| Dock lift cycle | 2 min | assumed |
| Time per 2.3 m row | 0.15 min | assumed |
| Outgoing mail | 3 carts/hr per building | assumed |
| Carts that pause in a bay | 5% for 1–2.5 min | assumed |
| Van trip, order to dock | 3–8 min | assumed |
| Dock work per delivery (open, inspect, pull onto dock, scan) | 0.6–11.8 min, mean 8.4 | measured (H-E-B, 4 trials) |
| Dock crews | 3 | assumed |
| Parcels per cart | 10–30 | assumed |
| Raised-floor depths | 41–70 mm office, 0.8–1.0 m data centre | sourced |

Type measured values into *Fleet & data → What the numbers rest on*, and the tag changes to **measured**.

**What the model cannot know:** tenant lifts are drawn but not simulated. There is no maintenance, charging, turning radius or structure. The traffic controller is a planner rule, not physics.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app: page, styles, map, charts, with the simulation inlined |
| `sim.js` | The simulation on its own, for reading: the same rules as the A3 toy (rows, passing bays, dock lift, jam detection) plus random arrivals, fixed destinations and event hooks |
| `README.md` | This file |

## Related

- [Under the Block](../toy/index.html): the toy with the Little's law known-result panel (A3 Move 2)
