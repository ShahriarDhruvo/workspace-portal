# Measurements

What was measured on the test machines, and what was tried and left out. The engine and fan settings these
numbers led to are in [`llm-server/`](../llm-server).

- **AI server:** Bosgame M5, Ryzen AI Max+ 395, 128 GB, board AXB35-02, BIOS 3.11, Fedora 44.
- **Portal server:** Pentium G4400T (2 cores), 8 GB, Fedora 45.
- One unit of each, at room temperature. Power and temperature are the chip's own sensors, not a wall meter.
- tok/s is tokens per second. Reading is prompt processing, writing is the answer.
- The fan, model, engine, photo and full-machine measurements date from kernel 7.2.15 and were not repeated
  with 7.3.4. The sections measured on 7.3.4 say so.

## Settings and what they buy

| Setting | Value | Measured |
|---|---|---|
| UMA, the GPU's fixed memory | 512 MB | Linux sees 124.9 GiB. The machine shipped at 64 GB fixed, which leaves Linux about 62. |
| GTT limit, RAM the GPU may borrow | 124 GiB | The model and all four sessions sit on the GPU: 111.5 GiB in use. |
| IOMMU | off | Other owners report 5-15% faster prompt reading. Not compared here; every number was taken with it off. |
| Power profile | Performance | 120 W sustained, 140 W slow, 160 W peak, 98 °C. |
| Power and temperature limits | The firmware's maximum | Asked for 180 W and 100 °C, it keeps 132 W sustained, 140 W slow, 160 W peak and 98 °C. Since November 27, 2026; see [Freezes](#freezes) for its heat. |
| CPU undervolt | Curve offset -25 | 3.7% more CPU work at the same power. -50 gives 8% at 11 W less and 9 °C cooler, but froze the machine five times ([Freezes](#freezes)). |
| Fan curve | 99% from 70 °C | Up to 95% before November 27: chip about 6 °C cooler than on firmware fans. Reading holds 1,760-1,787 tok/s instead of sagging to as low as 1,484 after long load: up to 20% faster when hot. |
| Cooling under the machine | A laptop cooler, its fan at 3,500 rpm | Since November 27, 2026; not measured alone. |
| CPU governor | performance | TuneD profile `accelerator-performance`. Baseline for all numbers. |
| N-gram table | 8.5 bits a value (Q8_0) | Predicts like the full-precision table, which is 48 GB larger. Wikitext is predicted 0.3% better than with the 4.5-bit table of the Q4 files, code the same. Same memory and speed; 26 GB more on the SSD. |
| Speculative decoding | MTP | A helper file drafts tokens ahead and about 80% are accepted. Writing runs at 51 to 79 tok/s, half of the runs at 62 to 67 (99 runs with three n-gram tables, November 20 and 21, 2026), against 24 to 27 on llama.cpp without it. |

## Levers tried and left alone

`ryzenadj` is [RyzenAdj](https://github.com/FlyGoat/RyzenAdj) 0.18.0 from
[COPR shdwchn10/ryzenadj](https://copr.fedorainfracloud.org/coprs/shdwchn10/ryzenadj/), with its `ryzen_smu` driver;
its settings last until the next reboot. Stock limits (`sudo ryzenadj --info`): STAPM 120 W, fast limit 160 W, slow
limit 140 W, temperature limit 98 °C.

| Lever | Result | Verdict |
|---|---|---|
| More power<br>`sudo ryzenadj --stapm-limit=180000` | The firmware caps the sustained limit at 132 W, the slow one at 140 W and the fast one at 160 W, whatever is asked (again November 27). Before the 99% fan curve and the laptop cooler, 132 W was slower: 1,741 and 1,667 tok/s against 1,787 at 120 W, 4-6 W more, 2-3 °C hotter, more time throttled at 98 °C. | in use since November 27 |
| Higher temperature limit<br>`sudo ryzenadj --tctl-temp=100` | Reads back as 98 °C, the maximum this firmware allows (again November 27). The skin limits are refused: `set_apu_skin_temp_limit is not supported on this family`. | locked |
| Lower temperature limit<br>`sudo ryzenadj --tctl-temp=90` | Works. The chip peaks at 90 °C and the fans run about 8% slower. Prompt reading drops 2.2%. A limit of 95 °C cost 3.6% in a second back-to-back test. November 26, one 59,000-token prompt from cold: 3% slower, yet the chip overshot to 95 °C, the GPU to 97 °C and power to 176 W, hotter than the 120 W limit ([Freezes](#freezes)). | costs speed |
| Fans at 100% | Worse than 99%. On November 27, cold, both held about 4,400 rpm for 25 seconds, then fell and cycled between 1,260 and 2,560 rpm for the rest of 2 minutes. Earlier, hot, fan 1 averaged 2,150 rpm and the chip ran at 87-89 °C instead of 83. The driver refuses 100. | worse |
| GPU overclock<br>`sudo ryzenadj --gfx-clk=3000` | `set_gfx_clk is rejected by SMU`. The driver's own limit is 2,900 MHz and it refuses 3,000 as well. Under AI load the GPU averages 2,680-2,750 MHz, below its cap. | locked |
| GPU clock forced to maximum | 1,739 tok/s, the same as stock. Idle power doubles from 7.5 to 15.6 W. | no gain |
| Power limit 100 W | Prompt reading 10% slower, the chip peaks at 82 °C. | costs speed |
| GPU undervolt<br>`sudo ryzenadj --set-cogfx=1048526` | `set_cogfx is not supported on this family` | locked |
| CPU overclock | No BIOS option, and `ryzenadj` has no clock or voltage control for this chip. | locked |
| RAM speed | Rated for 8,533 MT/s, runs at 8,000. The firmware sets that at power-on; there is no setting in the BIOS or in Linux. The most it could add is 6.7% writing speed. | locked |
| GPU job timeout<br>`amdgpu.lockup_timeout=60000` | Without it the full-load test passes, a 12-megapixel image is read, and the kernel logs no GPU timeout. | not needed |
| Repaste | Not tried. It means opening the case, and the fan curve already removes most of the throttling. | not tried |

## Fans

| Fan control | Chip in a long run | Prompt reading |
|---|---|---|
| Firmware | At 98 °C for 24-51% of the run; 86-94 °C average | Sags from about 1,740 to between 1,484 and 1,745 tok/s, depending on how warm the case already is (seven runs) |
| Held at 80, 90 or 95% | 83-89 °C average | 1,760-1,787 tok/s in all eight runs |

- Short jobs gain about 3%, long hot ones up to 20%. Writing speed does not change: it depends on memory
  bandwidth, not on temperature.
- The upstream driver's stock fan settings do nothing on BIOS 3.11: the firmware's top fan level is only about
  3,000 rpm.
- Fan speed by duty: 40% to 75%, about 2,500 to 3,800 rpm; 80%, about 3,900 rpm; 95%, about 4,300 rpm; 99%, 4,454
  and 4,341 rpm on average over 2 minutes, never under 4,300, the top speed. With the firmware in control right
  after a load: 2,120 and 2,321 rpm. The third fan, about 1,000 rpm under load, has no duty register.
- Burn-in on stock fans, 30 minutes of `stress-ng` on all cores and an hour of `stressapptest` over 108 GB:
  about 98 °C in the CPU test, about 95 °C in the RAM test. Both passed at full length on November 17, 2026.

## Power profiles

| Profile | Sustained / peak | Measured |
|---|---|---|
| `performance` | 120 W / 160 W | Every other number here. 121-128 W under load, about 7 W idle. |
| `balanced` | 85 W / 120 W | |
| `quiet` | 55 W / 100 W | Prompt reading 28% slower (1,312 tok/s). |

## CPU undervolt

A curve offset of -25 on every core since November 27, 2026, set at each boot by `llm-server/apu-tuning.service`.
-50 was in use November 18 to 26 and again on November 27, and the machine froze five times with it
([Freezes](#freezes)). The same 45-second all-core test (`stress-ng --cpu 32 --cpu-method matrixprod --verify`)
from 50 °C, November 27, at the firmware's maximum limits, kernel 7.3.4; fans at 99% from 85 °C for none and the
offsets from -50, from 70 °C for the others:

| Offset | Work | Clock | Power | Chip, peak |
|---|---|---|---|---|
| none | 24,034 and 23,811 operations a second | 4,662 and 4,626 MHz | 141 and 137 W | 98 °C, the chip's limit |
| -10 | 24,096 | 4,680 MHz | 132 W | 98 °C |
| -20 | 24,546 | 4,769 MHz | 132 W | 98 °C |
| -25 | 24,805 | 4,820 MHz | 133 W | 98 °C |
| -30 | 25,008 | 4,859 MHz | 133 W | 98 °C |
| -40 | 25,344 | 4,927 MHz | 131 W | 96 °C |
| -50 | 25,775 and 25,725 | 5,016 and 5,003 MHz | 128 and 127 W | 89 °C |
| -70 | 25,743 | 5,009 MHz | 127 W | |
| -100 | 25,744 | 5,008 MHz | 127 W | |

- Down to -30 the chip stays at its power and temperature limits and the offset becomes clock, about 1.5% more
  work for each 10. From -40 the cores near their top clock and the chip runs cooler. No arithmetic errors at
  any offset. -70 and -100 are accepted and change nothing, as -55 through -200 did on November 18 (kernel
  7.2.15): -50 is the floor.
- -25 keeps half the gain of -50 on half its voltage cut. Whether it never freezes cannot be tested quickly: at
  -50, ten minutes of random load changes and the full-load test passed, and the freezes came hours or days
  apart.
- The GPU, which does most of the LLM's work, has no such setting: RyzenAdj answers `set_cogfx is not supported
  on this family`, and the driver's `pp_od_clk_voltage` offers only the clock range, 600 to 2,900 MHz.
- Prompt reading gained about 1% on kernel 7.2.15, from 1,815 and 1,819 tok/s to 1,836 and 1,832.
- November 18, with the offset on: all cores checked their arithmetic for 5 minutes and each of the 16 cores
  alone for 30 seconds, twice, without an error.
- November 20, with the offset on, a 102 GB download came out with one bit changed and btrfs reported no
  error, so the bit changed in memory or in the CPU before it reached the disk.
- Set by hand with `sudo ryzenadj --set-coall=1048551`, which is 1048576 minus the offset and lasts until a reboot.

## Freezes

The AI server stopped under LLM load on November 19, 2026 at 06:43 UTC and November 26 at 19:10 UTC. On
November 26 it froze and was switched off by hand; November 19 looks the same in the log. A third boot, at 19:16
UTC, ended 13 seconds in, while the LLM loaded. Each following boot logged `x86/amd: Previous system reset
reason [0x00200800]: ACPI power state transition occurred`, which is what holding the power button leaves. The 22
boots before them, November 3 to 18, all logged `[0x00080800]: software wrote 0x6 to reset control register
0xCF9`, an ordinary reboot. Two more freezes followed on November 27, below.

- Both came while writing a reply, just after prompts of 129,553 and 116,102 tokens. The log, written every
  second while writing, stops mid-reply (at token 351 on November 26) with no kernel message, and the portal lost
  the server 15 seconds later. The owner found it not answering and switched it off about 6 minutes later.
- Writing draws far less power than reading a prompt, so heat is an unlikely trigger.
- Not memory: a minute before the second, Gufo logged 21.8 GiB of RAM free and its own memory at 3.2 GiB.
- Rare: between the first two the machine read 1,018 prompts of over 50,000 tokens, each holding the chip at its
  temperature limit (table below), in 7 days without a freeze.
- The BIOS reports version 3.11 of May 8, 2026, the date of Bosgame's BIOS file 1.09, with power firmware
  100.7.0 (`smu fw version` in `dmesg`).
- The same silent freeze, the log cut mid-line, no hang message, a hard power-off needed, is described on Strix
  Halo with power firmware 100.6.0. There AMD is reported to have confirmed a race in the power firmware's
  command handling, with a fix in progress and no date
  ([Framework wiki](https://framework.wiki/docs/problems/desktop-gpu-hangs/), seen November 27, 2026).
- Bosgame's newer BIOS 1.10 of November 4, 2026, from Bosgame support with no changelog, carries power firmware
  100.16.0 ([Strix Halo wiki](https://strixhalo.wiki/Hardware/Boards/Sixunited_AXB35/Firmware/)). On it one
  owner's M5 still reset or froze within hours of GPU-only LLM runs, with ROCm and with Vulkan, until the fabric
  clock was held at 1,000 MHz or more: 29.5 and 33.9 hours clean, and removing the floor brought the failures
  back ([ROCm/TheRock#9973](https://github.com/ROCm/TheRock/issues/9973), comments of November 22 and 24, 2026).
  One owner, not confirmed by AMD. That BIOS is flashed from Windows, and a failed flash needs a chip programmer.
  Neither the BIOS nor the floor was tried here.
- Other Bosgame M5 owners report hard power-offs during long LLM runs, one on BIOS 3.11 in the Performance
  profile, twice in 4 days ([Hardware Busters](https://hwbusters.com/systems/bosgame-m5-fan-control-broken-as-shipped-so-i-fixed-it-with-a-free-plugin/),
  seen November 26, 2026).
- November 27 at 04:08 UTC, a minute after a reboot, with the offset at -50 and the firmware's maximum limits
  applied at boot, the machine hung during a 25-second all-core CPU load; the LLM had just loaded. The watchdog
  reset it 30 seconds later, the next boot logged `[0x02000800]: hardware watchdog timer expired`, and it was
  back in about 90 seconds. That boot's log ends 18 seconds before the last command it answered: a hang loses the
  log's last seconds, so the 13-second boot of November 26 may have run longer.
- November 27 at 04:25 UTC, 11 minutes into the full-load test with -50, the firmware's maximum limits and the
  99% fan curve, the chip at its 98 °C limit and the GPU at 104 °C: the power firmware stopped answering
  (`amdgpu: SMU: No response msg_reg: f resp_reg: 0`). The machine kept running, but Gufo saw no progress and
  after 10 minutes gave up (`event=device_lost`), all four replies came back empty, and a GPU reset failed (`MES
  might be in unrecoverable state`). The fan service lost the GPU's temperature and held 99%, as designed. Two
  loggers were each asking the power firmware for readings every second through RyzenAdj, on top of
  portal-hostd's one request every 2 seconds. The reboot then hung at its last step, and the watchdog did not
  reset it in 20 minutes: the power button was needed.
- The same test again at 05:01 UTC, the same settings, with a logger that asks the power firmware nothing: both
  verdicts `PASS`. Five seconds after it ended, at 05:20, as the load fell away, the machine froze; the watchdog
  reset it and it was back in 90 seconds.
- All five freezes came with the CPU undervolt at -50: two while writing a reply, one during a boot, and two
  right as a load started or ended. None came in the 22 boots of November 3 to 18, before it, nor between its
  removal on November 26 and its return on November 27.
- Since 05:39 UTC, November 27, the offset is -25 ([CPU undervolt](#cpu-undervolt)): the full-load test passed,
  and ten minutes of random load changes, bursts on all cores or one with short LLM replies alongside, ran 158
  bursts without a fault. The same ten minutes at -50 had passed too, so only time will show.
- The chipset's watchdog now reboots the machine after a 30-second hang, so a freeze ends in a reboot that logs
  `hardware watchdog timer expired`. A hang of the whole chip may stop the watchdog too; then the power button is
  still needed.

Heat while reading one prompt of about 59,000 random tokens and writing 1,500, from 45 °C (kernel 7.3.4, Gufo
0.37.0). November 26 with the offset at -50, fans up to 95%, no cooler under the machine; November 27 with the
settings in use:

| APU limits: sustained / slow / fast | Reading | Writing | Chip, peak | GPU, peak | ACPI zone, peak |
|---|---|---|---|---|---|
| 120 / 140 / 160 W, the Performance profile | 1,824 tok/s | 87.5 tok/s | 102 °C | 104 °C | 98 °C |
| 120 / 120 / 120 W | 1,718 | 86.0 | 93 °C | 91 °C | 88 °C |
| 100 / 100 / 100 W | 1,643 | 77.5 | 82 °C | 82 °C | 80 °C |
| 132 / 140 / 160 W, the firmware's maximum; offset -25, fans 99% from 70 °C, laptop cooler | 1,828 | 79.2 | 98 °C | not read | 98 °C |

- At the Performance profile the chip reaches its 98 °C limit 5 seconds into the prompt and stays there; the
  ACPI zone climbs from 46 to 98 °C in 15 seconds. The kernel would only act at that zone's critical point,
  110 °C.
- One run each. Writing speed varies with the random text, so its drop at 100 W is uncertain.
- November 27 the chip reaches its 98 °C limit 7 seconds into the prompt. The GPU's temperature was not read:
  every reading is a request to the power firmware.

The full-load test (`llm-server/acceptance.py`), four 256K prompts at once and a follow-up each:

| Settings | First words of the four | Power, average | Chip, average and peak | Verdict |
|---|---|---|---|---|
| November 26: 120 W cap, no offset, fans 95% from 90 °C | 309, 322, 642, 662 s | 118 W | 88 °C, 94 °C | `PASS` |
| November 27: the firmware's maximum, -50, fans 99% from 85 °C, two loggers asking the power firmware every second | 288, 300, 617, 636 s | 134 W | 97 °C, 98 °C | `FAIL`: the power firmware stopped answering |
| The same, with a logger that asks it nothing | 287, 299, 606, 625 s | 133 W | 97.5 °C, 98 °C | `PASS`, then a freeze 5 s after |
| November 27: the firmware's maximum, -25, fans 99% from 70 °C, laptop cooler | 294, 306, 628, 647 s | 132 W | 97.7 °C, 99 °C | `PASS`, then 10 minutes of load changes without a fault |

- Power in the first two rows is the socket power the GPU driver reports, in the others the CPU's own package
  counter (RAPL), which asks the power firmware nothing.
- Each run took about 19 minutes, not 11: the follow-ups often found their session's memory reclaimed and read
  their prompt again (Gufo 0.37.0's log), so their times vary from 150 to 480 seconds whatever the settings.
- With the firmware's maximum the chip sits at its 98 °C limit for 95% of the run, both fans at their top speed;
  first words come 2 to 5% sooner than at the 120 W cap.

## Memory

The AI server's 128 GiB with the model loaded and four 256K sessions, idle after the tests under [Load](#load)
(`/proc/meminfo` and the GPU's `mem_info_gtt_used`):

| Use | GiB | Share |
|---|---|---|
| Model, MTP, vision and 4 sessions on the GPU | 111.5 | 87% |
| Prompt cache (3.6 of its 4 GiB in use), Gufo and Linux | about 7 | 5% |
| Free | 6.6 | 5% |
| Never available to programs | 3.1 | 2% |

The last row, from the boot log: 2.0 GiB is the kernel's record of every 4 KiB page (64 bytes each), 0.5 GiB the
GPU's fixed memory, 0.35 GiB firmware and 0.23 GiB the kernel itself. The portal server's 8 GiB lose 0.37 GiB the
same way (0.12 page records, 0.11 firmware with 32 MiB for graphics, 0.14 kernel) and show as 7.6 GiB.

| Layout | Free memory | Timings |
|---|---|---|
| 4 × 256K | 9.6 GiB after load. Lowest: 5.7-7.0 GiB with four full prompts at once (six runs), 4.7 GiB while four raw 12 MP photos were read | See [Load](#load) |
| 4 × 225K | 12.7 GiB after load. Lowest: 9.1 GiB with four full prompts at once | See [Load](#load) |
| 7 × 128K | 11.7 GiB after load, about 6 GiB while in use. Lowest: 5.7 GiB with seven full prompts at once on Gufo 0.34.0 (8.8 GiB on 0.35.0, right after a restart), 4.0 GiB while a raw 12 MP photo was read | See [Load](#load) |
| 3 × 256K | About 12 GiB under full load, with an idle workspace stack next to the model | Three 259,000-token prompts at once: first words after 8 minutes, follow-up turns after 0.7 seconds |

Agents on the AI server itself, four sandboxes of 3 GB each next to the model. The 3 × 256K layout was not
tried with busy sandboxes.

| Layout | Lowest free memory |
|---|---|
| 7 × 128K | 1.2 GiB |
| 6 × 128K | 1.1 GiB |
| 5 × 128K | 3.0 GiB (0.6 GiB in a second run) |
| 4 × 128K | 4.1 GiB |

## Load

Four 256,000-token prompts at once (`llm-server/acceptance.py`), one run on November 18, 2026, Gufo 0.35.0:

- All four sessions wrote their first word after 629 to 634 seconds, and every tool call was correct.
- The follow-up turns answered in 0.7 to 1.1 seconds.
- Nothing was written to swap, nothing was killed for lack of memory, and free memory stayed above 7.0 GiB.
- The chip reached 100 °C.

The same sessions with images, right after it. The photo is a generated JPEG of 4,000 × 3,000 pixels, sent
straight to the API, 11,800 tokens to the model:

- Three 256,000-token prompts and the photo in the fourth session: first words after 507 to 519 seconds, the
  photo answered after 69 seconds, free memory above 4.8 GiB.
- Four such photos at once: answered after 37 to 38 seconds, free memory above 4.7 GiB.
- Four pictures of 1,568 pixels, the size Qwen Code sends: 5 to 6 seconds, and free memory did not move.
- In all of it nothing was written to swap, no request failed and the model never restarted.

Five more runs on November 20 and 21, 2026, with three [n-gram tables](#n-gram-table): first words after 632 to
639 seconds with the 4.5-bit table (two runs), 636 to 641 with the 8.5-bit one (one run) and 640 to 649 with the
full-precision one (two runs), every tool call correct. Free memory stayed above 5.7 GiB. Four runs moved 0 to 9
pages to swap; one, with the 4.5-bit table, moved 6,400, which the test reports as `CAPACITY FAIL`.

Four 225,000-token prompts at once, one run on November 18, 2026 with four sessions of 230,400 tokens:

- All four sessions wrote their first word after 546 to 554 seconds, and every tool call was correct.
- The follow-up turns answered in 0.7 to 1.0 seconds.
- Nothing was written to swap, nothing was killed for lack of memory, and free memory stayed above 9.1 GiB.
- The chip reached 99 °C.

Seven 128,000-token prompts at once (`--users 7 --target 128000`), two runs the same day:

- All seven sessions wrote their first word after 523 to 532 seconds, and every tool call was correct.
- The follow-up turns answered in 0.4 to 1.8 seconds, because the 128,000 tokens were already cached.
- Nothing was written to swap, nothing was killed for lack of memory, and free memory stayed above 8.8 GiB.
- For the first three minutes the chip ran at its limit, 98 °C on the CPU's sensor and up to 101 °C on the
  GPU's, with the fans at 95%. Then it held 88-89 °C.

A full machine, the worst case that was tried: seven clients each sent a 122,000-token prompt, eight more
requests queued behind them, a second wave of seven followed, and real agents worked at the same time.

- A new long prompt waited 9-17 minutes for its first word.
- Nothing failed, the model never restarted, and free memory stayed above 6.3 GiB.
- Once that load ended, agent turns started after 0.6 seconds (median of 278 agent requests) and wrote at
  53 tok/s: Gufo keeps each conversation and reads only what is new, about 540 tokens per turn in prompts of
  56,000 (median).

Images:

- Qwen Code shrinks images to 1,568 pixels on the long edge. A raw photo sent straight to the API on an idle
  server was answered after 147 seconds (12 MP) and 353 seconds (16.8 MP).
- Sent while another agent was writing, the 12 MP photo pulled free memory down to 4.0 GiB for a moment and
  still completed.
- A full-size 12 MP photo takes about 2.5 minutes to encode. With `--stall-timeout-ms` at 120 seconds that
  restarted the model, hence the 10 minutes in `llm-server/gufo.container`.

Engine update through Admin > Updates, November 17, 2026:

- 0.34.0 to 0.35.0 in 51 seconds, 15 of them for the 3.4 GiB download, and back in 31.
- A workspace that sent a request every second lost none; the two that arrived during a restart waited
  32 seconds.
- The day before, a forced bad update put 0.31.0 back by itself.

After a reboot, November 18, 2026: Gufo answers after 32 seconds and the portal, over HTTPS, after 22, counted
from the start of the kernel. A restart of Gufo alone is healthy after 17 to 18 seconds.

## Replies and thinking

On Gufo a reply's `max_tokens` includes its thinking, and the effort level is an instruction to the model, not
a limit. November 18, 2026, Gufo 0.35.0, Qwen Code 0.28.0:

- With seven 128K sessions, Qwen Code's context at 131,072 and `max_tokens` at 32,768, three turns of one agent
  session ended without an answer. Their prompts were 88,000 to 93,000 tokens, Qwen Code had shrunk the replies
  to 26,000-26,700 tokens to fit the context, and the model spent all of them thinking, 7 minutes each. With
  `max_tokens` in its settings Qwen Code does not continue a reply that was cut off.
- The same kind of task, a 93,700-token document to summarize, with four 225K sessions, 64,000-token replies
  and `--reasoning-budget 32000`, both efforts at once:

| Effort | Thinking | Answer | Time |
|---|--:|--:|--:|
| `xhigh` | 26,349 tokens | 25,999 tokens, complete | 17.7 min |
| `low` | 387 tokens | 7,490 tokens, complete | 5.0 min |

- `--reasoning-budget` ends the thinking after that many tokens. Neither run reached it.
- Qwen Code asks for 64,000 tokens for a qwen3 model when its settings name no `max_tokens`: every request of a
  session in a portal workspace carried it. It asks for less when the context has less left after a 5% margin:
  with its own compaction point, 85% of the context, 26,000 tokens in a 262,144-token session; with
  `autoCompactThreshold` 0.7 (`models/system-defaults.json`) it compacts at 183,500 tokens, where 64,000
  still fit. The last two numbers come from running Qwen Code's own functions, not from a session that long.
- That session, at `low`: the agent read the same document with its file tool and answered a 110,500-token
  prompt with 33,300 tokens, three quarters of them thinking, in 13.8 minutes. The old settings left such a
  reply 10,500 tokens.
- With four 256K sessions, in a portal workspace at `low`, twice: the agent read a 152,600-token document with
  its file tool, in prompts that grew to 175,800 and 166,500 tokens and asked for 64,000 each. It answered a
  168,600-token prompt with 21,600 tokens in 6.5 minutes and a 162,100-token prompt with 18,000 in 5.2. The
  first answer came in Chinese, to an English document and request, and ended at a heading mark; the second
  was English and complete. With sessions of 230,400 tokens Qwen Code compacts such a conversation at 154,000.
- A reply cut off at its limit (forced, 3,000 tokens): Qwen Code asked the model to resume, and the model picked
  up mid-word in 7 of 8 tries; in one it wrote a single letter and stopped.
- Qwen Code ends a reply's stream after an hour (`QWEN_STREAM_MAX_LIFETIME_MS` in the workspace image; 15 minutes
  without it, and 0.28.0 does not read `streamMaxLifetimeMs` from a model's entry), then asks the model to
  resume, which it did. A 64,000-token reply stays under the hour at 18 tokens a second; with three sessions
  writing, two long replies got 30 and 34.

## Model and engine

Nine setups ran the same ten coding tasks, three agents at a time, each task checked by an independent grader
with a 30-minute limit. Each row ran once, with short starting prompts: it shows which setup gets agent work
done on this hardware, not a ranking of the models.

| Model and engine | Finished | Correct files | Median task |
|---|--:|--:|--:|
| **Qwen3.8-Flash-Next Q4 · Gufo 0.31, MTP** | **7 / 10** | **9 / 10** | **8:25** |
| Flash-Next Q5 · llama.cpp fork, no MTP | 7 / 10 | 9 / 10 | 21:21 |
| Flash-Next Q6 · llama.cpp, no MTP | 7 / 10 | 9 / 10 | 22:51 |
| Flash-Next GSQ IQ3 · llama.cpp, no MTP | 7 / 10 | 7 / 10 | 9:26 |
| MiMo V2.6 Flash, mixed IQ2 · llama.cpp | 7 / 10 | 7 / 10 | 18:31 |
| DeepSeek V4.1 Flash IQ1_M · llama.cpp | 6 / 10 | 8 / 10 | 19:25 |
| Qwen3.8-27B Q8 · Gufo, no draft model | 3 / 10 | 4 / 10 | 30:02 |
| GLM-5.3-Flash EXL3 · Kyojin | 0 of 4 | 1 of 4 | stopped early |
| MiniMax M3.1 Flash · Maya-XS FP4 | 0 of 3 | 1 of 3 | stopped early |

Flash-Next Q4 on Gufo ties for the best score and needs well under half the time of the others that tie.
Gufo 0.30 scored the same as 0.31, with a median of 8:22.

### Bigger quantizations

- Q5 (158 GB) and Q6 (169 GB) are larger than the RAM, so part of the file is read from the SSD while the
  model runs. They scored the same as Q4 and took about 2.5 times as long.
- Q5 writes 23 tok/s for one user, and four 128K sessions of it filled the RAM and fell to 0.5 tok/s each.
- Against Q5 on the same text, Q4's perplexity is 0.35% worse (3.831 against 3.818) and it picks the same next
  word 94.1% of the time. The Q5 files also hold the n-gram table at 8.5 bits instead of 4.5: see
  [N-gram table](#n-gram-table).
- Q4 is the largest Flash-Next file that Gufo loads.

### N-gram table

Flash-Next has a table of 51.2 billion values that Gufo reads from the SSD a few rows at a time, while the rest
of the model stays in memory. Unsloth's Q4 files bring it at 4.5 bits a value (IQ4_NL, 28.8 GB), in the
revision the guide uses as a file of its own. The repository has the table to put in that file's place at 8.5
bits (Q8_0, 54.4 GB) and at full precision (BF16, 102.4 GB). On 3,000 random rows an IQ4_NL row is off its BF16
row by 7.6% and a Q8_0 row by 0.5%, as Unsloth lists.

The same Q4 model with only the table swapped, November 20 and 21, 2026.

**What the model predicts.** llama.cpp b12464 scored 102,400 tokens of each text in chunks of 2,048, and 98,304
in chunks of 32,768, and compared every prediction with the BF16 table's. The control is the BF16 table once
more with the prompt computed in batches of 256 tokens instead of 512: the same arithmetic in another order.

| Text | Table | Perplexity against BF16 | Same top token as BF16 | KL divergence from BF16 |
|---|---|--:|--:|--:|
| wikitext-2 test | IQ4_NL | **+0.30%** | 95.12% | 0.0184 |
| | Q8_0 | +0.03% | 96.17% | 0.0112 |
| | control | +0.00% | 96.10% | 0.0112 |
| This repository's source | IQ4_NL | -0.07% | 95.39% | 0.0255 |
| | Q8_0 | +0.10% | 95.80% | 0.0208 |
| | control | +0.02% | 95.77% | 0.0207 |
| The same in 32,768-token chunks | IQ4_NL | +0.11% | 96.23% | 0.0196 |
| | Q8_0 | +0.11% | 96.63% | 0.0159 |
| | control | +0.12% | 96.60% | 0.0159 |

- The perplexity differences have a standard error of 0.06 to 0.09 points.
- The control is as far from BF16 as Q8_0 is. Reordering the arithmetic alone changes the top token at 3.4 to
  4.2% of the positions, while a second run with nothing changed reproduces 99.999%. Only what exceeds the
  control is the table's doing, and Q8_0 exceeds it nowhere.
- IQ4_NL changes the top token at 1.0 point more positions than the control on wikitext and 0.4 on the code, 10
  and 6 standard errors. On wikitext its perplexity is 0.30% worse, 3.3 standard errors; on the code it is the
  same.
- IQ4_NL against Q8_0 directly: its perplexity is 0.27% worse on wikitext (2.9 standard errors), 0.17% better
  on the code in chunks of 2,048 (2.0) and the same in chunks of 32,768.
- Against the Q5 model with the BF16 table, on the code, the Q4 model's KL divergence is 0.0464 with IQ4_NL,
  0.0443 with BF16 and 0.0441 with Q8_0. Q5's own perplexity there is within 0.1% of Q4's.
- llama.cpp swaps the table with `--ple FILE`. With the BF16 table it also needs `-lm mmap`: without it the
  table is loaded into RAM, 95 GiB next to the model, and the run is killed for memory.

**Answers**, through Gufo 0.35.0, greedy:

- 76 LiveCodeBench problems from December 2024 to April 2025, 60 medium and 16 hard, four at a time, thinking
  ended after 3,000 tokens, each answer run against the problem's tests: 52 solved with IQ4_NL, 52 with BF16 and
  54 with Q8_0. Between any two tables 16 to 22 problems were solved with one and not with the other, split 11
  to 11, 9 to 11 and 7 to 9: chance. The thinking took 159,348 tokens with IQ4_NL, 159,411 with BF16 and 155,855
  with Q8_0.
- `gufo eval`, 75 questions: 56 right with IQ4_NL, 53 with BF16. They disagree on 7 questions, 5 to 2, and
  four of the five were BF16 answers cut off at the 16,000-token limit while still thinking. That is chance
  (sign test p = 0.45). Not run with Q8_0.
- Next word at 3,681 positions of wikitext-2: the right one at 63.7% with IQ4_NL, 63.3% with BF16 and 63.6% with
  Q8_0. No two differ by more than 0.4 points, and each 95% interval spans zero: too few positions to show a
  difference of the size above.
- At those positions Q8_0 has BF16's top token 96.9% of the time and IQ4_NL 94.9%, 5.8 standard errors apart.
  A second run with IQ4_NL reproduced every prediction of the first. So did, at 300 positions, the revision the
  guide uses, where that table is the fourth file: the other IQ4_NL runs used an older revision that has it
  inside the second.

**Speed**, Gufo 0.35.0, each run after a restart and with the page cache dropped: three runs with IQ4_NL, two
with each of the others.

| | IQ4_NL | Q8_0 | BF16 |
|---|--:|--:|--:|
| Reading a 2K prompt, tok/s | 1,627-1,846 | 1,729-1,772 | 1,598-1,736 |
| Reading an 8K prompt | 1,826-1,920 | 1,857-1,918 | 1,823-1,863 |
| Reading a 32K prompt | 1,819-1,861 | 1,847-1,854 | 1,788-1,832 |
| Reading a 64K prompt | 1,755-1,804 | 1,754-1,824 | 1,753-1,762 |
| Reading a 128K prompt | 1,714-1,721 | 1,717 and 1,720 | 1,711 and 1,719 |
| Writing, five 1,000-token answers | 49.9 in each run | 50.2 and 50.2 | 50.2 and 50.2 |
| Writing after a 64K prompt, the same four prompts for all | 50.8 and 51.8 | 51.5 and 52.7 | 51.2 |
| The guide's speed check, sampled answers | 54.5-73.0, median 64.3 (40 answers) | 52.0-69.0, median 64.9 (20) | 51.4-78.9, median 65.7 (39) |
| Four users at once, writing, each | 18-33 | 18-33 | 19-31 |
| Four users at once, reading, each | 1,541-1,938 | 1,655-1,922 | 1,529-1,843 |
| GPU memory in use | 110.8-111.5 GiB | 110.8-111.6 GiB | 110.8-111.5 GiB |
| Read from the SSD per token of a prompt of 32K or more | 27-38 KB | 30-43 KB | 42-46 KB |
| Four 256,000-token prompts, first words | 632-639 s, two runs | 636-641 s, one run | 640-649 s, two runs |
| Model load, as Gufo logs it | 16.4-19.3 s | 15.8-17.0 s | 16.3-17.6 s |

- `/models` on the test machine is on btrfs, which Fedora mounts with `compress=zstd:1`. The BF16 values
  compress, and every row read then unpacks a whole compressed extent: 264-283 KB from the SSD per prompt
  token, and prompts read 10-16% slower. The numbers above are from uncompressed tables: `chattr +m` on the
  folder before the download keeps btrfs from compressing what lands in it. The guide's `/models` is XFS, which
  does not compress.
- Q8_0 is in use since November 20, 2026. Over the 4.5-bit table it costs 26 GB of SSD, no memory and no speed
  that these runs show. What it buys is small: 0.3% on wikitext, predictions as close to the full-precision
  table's as a reordering of the arithmetic leaves them, and nothing that the code or the answers show. BF16
  measured the same as Q8_0 and takes 48 GB more.

### Gufo and llama.cpp

Each engine's own benchmark tool, one session, Gufo 0.28.1. Gufo reads prompts three to four times as fast.

| Engine, same Q4 file | Reading, tok/s | Writing, tok/s |
|---|--:|--:|
| **Gufo** with MTP | **1,862** (1,653 at 32K) | **61.4** |
| Gufo without MTP | 1,899 (1,717 at 32K) | 29.6 |
| llama.cpp, ROCm | 656 (424 at 32K) | 24.1 |
| llama.cpp, Vulkan | 615 (372 at 32K) | 27.2 |

### Halogen and Strata

Three clients at once, each with its own prompt of about 8,000 tokens and a 1,024-token answer. The rate is
all output in tok/s over the whole request, prompt reading included. Cold is a new prompt, warm the same
prompt again.

| Engine, same Q4 file | Three clients, cold / warm | Lowest free memory |
|---|--:|--:|
| **Gufo 0.30** with MTP | **48.4 / 61.3** | 13.7 GiB |
| Gufo 0.30 without MTP | 44.1 / 57.0 | 18.5 GiB |
| Halogen | 46.5 / 46.8 | 8.2 GiB |
| Halogen, prompt cache on | 46.0 / 62.0 | 6.3 GiB |
| Strata 0.2.10 | 30.5 / 52.7 | 20.4 GiB |

- The Gufo row with MTP is the median of three runs; the others ran once. Strata's first start failed; the row
  is its second run.
- With a single client: Gufo 34.2 / 39.8, Halogen 33.5 / 33.7, Strata 25.5 / 39.3.
- Halogen is as fast as Gufo here but leaves 6-8 GiB free where Gufo leaves 14, and it is closed source.
- Neither Halogen nor Strata ran the coding tasks or a full-context test.
- Other model files in the same test, three clients: Flash-Next Q5 on the llama.cpp fork 30.8 / 47.2,
  Flash-Next GSQ IQ3 33.5 / 55.4, MiMo V2.6 Flash 22.1 / 37.0.

### Full contexts

Three sessions, three different prompts that nearly fill the context, sent at once. Each had to find a key far
back in the text, make a tool call and answer the tool's result. Times are minutes:seconds to the first reply.

| Setup | Layout | First replies | Result |
|---|---|--:|---|
| **Flash-Next Q4 · Gufo 0.31** | 3 × 256K | **7:59-8:01** | Passed. A second run touched swap for a moment (10 pages). |
| Flash-Next Q4 · Gufo 0.30 | 3 × 256K | 8:31-8:32 | Correct, with 73 MiB written to swap. |
| Flash-Next Q5 · llama.cpp fork | 3 × 128K | 3:27-10:07 | Passed. |
| Flash-Next Q5 · llama.cpp fork | 3 × 256K | 7:10-21:51 | Correct, but swapping all the way. |
| Flash-Next Q6 · llama.cpp | 3 × 128K | 3:44-10:57 | Passed. |
| Flash-Next GSQ IQ3 · llama.cpp | 3 × 256K | 4:02-12:19 | Passed. |
| MiMo V2.6 Flash · llama.cpp | 3 × 128K, 3 × 256K | none | Failed both: no correct tool call. |
| GLM-5.3-Flash EXL3 · Kyojin | 3 × 128K | 3:03-9:49 | Correct. Reads the prompts one after another. |
| MiniMax M3.1 Flash · Maya-XS FP4 | 3 × 128K | 29:11-86:55 | Correct. Reads the prompts one after another. |
| Ling 3.1 Flash EXL3 · TabbyAPI | 3 × 128K | 97:45-100:47 | Correct, but swapping all the way. |
| DeepSeek V4.1 Flash · llama.cpp | 3 × 128K | none | Stopped by hand before it finished. No result. |

Coding with a long history, on Gufo 0.31: three sessions each started with 128,000 tokens of history and then
got a task. Two passed, in 12:33 and 14:09. The third spent its whole 24,576-token reply thinking and failed.

### Qwen3.8-27B

A third of the size, but slower here.

| | One user | Each of four |
|---|--:|--:|
| Qwen3.8-27B Q8 | 17 tok/s | 8.7 tok/s |
| Qwen3.8-27B Q4 with the DFlash2 draft model | 27 tok/s | 10 tok/s |
| Flash-Next, same test | 50 tok/s | 20.5 tok/s |

- A harder set with four agents at once: 12 of 20 tasks passed, where Flash-Next passed 18. Half of its
  failures used up the thinking budget before a single file was written; most of the rest ran out of time.
- An easier set of nine tasks run three times each: the 27B passed 26 of 27. Flash-Next passed 27 of 27 once
  one task, which had failed its first three attempts, was run again.

Tried once more on November 9 at Q8 with newer engines:

- Gufo with DFlash2: 20 tok/s for one user and about 6 each with six. Six prompts of 165,000 tokens at once
  waited 54-57 minutes for the first word and then wrote 2.8 tok/s each; one 250,000-token prompt took
  16 minutes to read. Gufo's MTP does not load the 27B files.
- llama.cpp is the only engine that fits six 256K sessions of it, at 11 tok/s for one user and 6 each with six.
- Halogen wrote 17 tok/s for one user and served six requests one after another.

## Image models

### Ming-Image-0.2-Design

Measured on November 27, 2026 on kernel 7.3.4: Ming-Image's own code at d561511 with its weights at 3538f4c in
BF16, on AMD's PyTorch 2.14.0 for ROCm 10.2.0, served by `llm-server/apps/ming/ming-images.py` (its default 12
steps), one request at a time, the weights in the page cache. Times run from sending the request to the whole
answer. GPU memory is the GTT counter and free memory MemAvailable, read every 0.25 s.

| Request | Time | GPU memory at most |
|---|--:|--:|
| Through llama-swap, 1024 × 1024, the LLM stopped first | 51.3 s | 95.9 GiB, both for a moment |
| Through llama-swap, 1024 × 1024, Turbo stopped first | 53.2 s | 52.6 GiB |
| Through llama-swap, 1344 × 768, the LLM stopped first | 52.4 s | |
| 1024 × 1024, loaded | 30.4 to 30.7 s | 53.3 GiB |
| 1344 × 768 | 30.3 to 30.4 s | 51.4 to 51.6 GiB, with the next row |
| 768 × 1344 | 30.2 s | |
| A poster with a headline and a line of small text | 30.6 s | |
| Two images in one request (`n` 2) | 61.6 s | |
| 2048 × 2048, the VAE decoding in tiles | 190.1 to 190.7 s | 53.7 GiB |
| 2048 × 2048, decoded whole | 195.2 s | 89.0 GiB |
| Qwen3-TTS beside Ming-Image, 3 s of speech | 4.0 s | 54.6 GiB |
| 1024 × 1024 with Qwen3-TTS loaded | 30.8 s | 60.9 GiB |
| A chat request after it, Ming-Image stopped first | 19.4 s | |

- The server is ready 17.9 s after it starts, with 46.4 GiB in use; the swap from the LLM adds about 21 s.
- The same seed and request gave a byte-identical image again. Text came out letter for letter: "BLUE HOUR" and
  "Friday 9 PM · Harbor Hall" at 1024 and at 2048.
- That evening its install moved to AMD's PyTorch 2.15.0 for ROCm 10.2.0, which the other programs use, and the
  numbers stayed: 30.5 s at 1024 × 1024 (53.7 s with the LLM stopped first), 30.2 s at 1344 × 768, 30.5 s at
  768 × 1344 and 189.7 s at 2048 × 2048, with 53.2, 51.4, 51.4 and 53.8 GiB at most.
- Ming-Image's code also has an edit task, which its model card does not describe. It took 78.2 to 78.9 s for a
  1024 × 1024 image and damaged the picture ([below](#qwen-image-21-turbo-edits-and-fast-images)), so the server
  no longer offers it: `/v1/images/edits` answers 404, an `image` in a generation 400, and edits go to
  Qwen-Image-2.1-Turbo. The edit timings cannot be repeated through the server.
- Decoding 2048 × 2048 whole takes 35 GiB more than the 48.4 GiB the denoising needs. In tiles of 1024 pixels, 896
  apart, it takes 2.3 GiB more, and the image differs from the whole one by 0.12 of 255 on average, 17 at most, in
  0.001% of its pixels by more than 8. The server tiles images larger than 1024 pixels on a side.
- PyTorch keeps what an image took for the next one unless it is told to give it back; the server gives it back
  after each image, so a loaded, idle Ming-Image holds 46.4 GiB.
- Both of PyTorch's attention kernels (flash and memory-efficient) run on gfx1151 without
  `TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL`, 250 ms each for 16,384 tokens of 30 heads.
- The weights take 52.9 GB on disk, the program with its Python packages 6.8 GiB.

### Qwen-Image-2.1-Turbo: edits and fast images

Measured on November 27, 2026 with Gufo 0.37.0 through llama-swap v277 (`llm-server/gufo-image-turbo.container`,
eight steps), one request at a time, seed 42, the weights in the page cache; 1024 × 1024 where a row names no size.
Times run from sending the request to the whole answer; GPU memory is the GTT counter, read every 0.25 s.

| Request | Time | GPU memory at most |
|---|--:|--:|
| A new image, the LLM stopped first | 25.7 s | |
| A new image, Ming-Image stopped first | 25.7 s | |
| A new image, loaded | 18.7 to 18.9 s | 31.7 GiB |
| A new image, 1344 × 768 | 18.2 s | |
| A new image, 768 × 1344 | 17.9 s | |
| A new image, 2048 × 2048 | 143.2 s | 41.9 GiB |
| An edit of one image | 29.2 to 30.2 s | 35.2 GiB |
| An edit of a 1344 × 768 image, no size sent | 31.5 s | |
| An edit of a square image with `size` 1344x768 | 29.0 s | |
| An edit of two images (`image[]` twice) | 40.2 s | |
| For comparison: the same edits on Ming-Image, before its server refused them | 78.2 to 78.5 s | 53.6 GiB |

- Both models edited the same two Ming-Image pictures. Asked to make a red teapot cobalt blue and put a white cup
  beside it, Turbo did both and kept the table, the window and the light. Ming-Image changed the colour, added no
  cup, and broke the table's wood grain into black speckles. Asked to change a poster's headline to "GOLDEN HOUR"
  on a warm orange background, both wrote the headline letter for letter and kept the small line and the drawing.
- As new images, Turbo's teapot was a clean photograph and its poster had the right text; Ming-Image's poster was
  the tidier design. So the registry's default for a new image is Ming-Image, with Turbo as the fast tier.
- An edit keeps its input's size when the request names none: the 1344 × 768 image came back 1344 × 768. With
  `size` the square image came back 1344 × 768.
- The two-image edit was asked to "put the teapot from the first picture on the stage of the poster in the
  second". It came back 1024 × 1024, with the teapot on the poster and the poster's text intact.
- `llm-server/media.json` offers the agent 1344x768 and 768x1344 from Turbo, and not 2048x2048 with its 143 s.
- The weights reach the GPU with the first request after a start: 7 s of the first row. The day before, with
  llama-swap v276: a chat request after an image, the image model stopped first, took 17.3 s (loading 15.3 s);
  llama-swap's start at boot loaded the LLM in 18 s; an engine update through llama-swap (hostd) took 16 s from
  the unload to the version check; llama-swap's own part of a swap was under 2 s.
- Downloading the weights (32.5 GB) with `gufo model install` took 13 minutes 22 seconds, at about 41 MB/s.
- Through the portal's LLM API after the deploy that evening, one request after another with one key: a 1344 × 768
  image from Ming-Image 50.5 s (the LLM stopped first), a new image from Turbo 26.1 s, an edit of it 29.3 s, an edit
  asked of Ming-Image 404 after 9.9 s, a tagged line from Drama 3 47.9 s for 4.3 s of speech (Turbo stopped
  first), and the next chat request 19.5 s.

## Media models

Measured on November 27, 2026 on kernel 7.3.4 through llama-swap v277, each request shaped as the portal sends
it: speech and transcriptions to llama-swap's `/v1/audio/speech` and `/v1/audio/transcriptions`, music and video
to `/upstream/<model>/v1/...`, recordings as 16 kHz mono FLAC. Engines: Gufo 0.37.0 for MiniMax H3, Qwen3-TTS and
Qwen3-ASR; Fish Speech v3.0.0-beta for S2-Pro; ACE-Step 1.5 v0.1.8 with both XL models in one process; vLLM 0.32.0
(kyuz0's gfx1151 image) for SOV-Transcribe-1 with its DFlash draft. Times run from sending the request to the whole
answer, for a video from creating the job to its MP4 downloaded. GPU memory is the GTT counter and free memory is
MemAvailable, both read every 0.25 s. The model files were in the page cache.

"Fish" in these tables is Fish Audio S2-Pro. [Drama 3](#fish-audio-drama-3) replaced it later the same day, so
its rows cannot be repeated: S2-Pro is no longer installed.

The test recordings are LibriSpeech readings with their reference text: 12.5 s, 34.6 s, and 302.9 s (the first 46
utterances of test-clean, two speakers). The word error rate (WER) counts words after lowercasing and removing
punctuation, with "Mr" read as "mister".

### Swap times

One request after another; "again" is the same request at once after it. H3 started with the Turbo image model
loaded, which it stopped.

| Request | Loaded before | With the swap | Again | GPU memory |
|---|---|--:|--:|--:|
| H3 video, 5 s at 512 × 512, `fast` preset | Turbo | 220.9 s | 205.3 s | 34.3 GiB at most |
| Fish speech, 7.8 s of audio | H3 | 53.5 s | 16.5 s | 19.2 GiB, 20.3 at most |
| SOV transcription, 34.6 s of audio | Fish | 89.3 s | 1.5 s | 88.8 GiB |
| ACE turbo, 30 s track | SOV | 29.7 s | 3.0 s | 22.4 GiB, 24.5 at most |
| ACE base, 30 s track | ACE turbo, the same process | 15.1 s | 15.1 s | 24.4 GiB at most |
| A chat request | ACE | 19.8 s | 0.19 s | 96.1 GiB |

Other swaps: Fish to ACE base 39.1 s; SOV and Fish back to the LLM 20.4 and 18.6 s.

Later the same day, with `StopTimeout=50` on every model container: a chat request sent straight to llama-swap took
20.6 s after SOV-Transcribe-1, 17.1 s after Qwen-Image-2.1-Turbo, 19.3 s after Drama 3 and 20.3 s after Ming-Image,
and no container was killed.

- H3 starts in 0.2 s and reads its weights during each job, so a first video is only 16 s slower than the next.
- SOV takes about 85 s to start. Its log shows 20 s for the 49.7 GiB of weights and 19 s to prepare the engine.
- ACE loads both models in about 24 s. The first turbo track took 5.4 s of generation, the next 2.8 s (its log).
- The same seed and request gave byte-identical output again from H3, Fish, ACE and qwen3-tts-1.7b.

### Speech models beside other models

The speech models have a group of their own and start beside whatever else runs; one speech model replaces
another. With `persistent: true` and `ttl: 300`, installed at 15:48, llama-swap keeps a speech model until 300 s
after its last answer. The qwen3-tts-1.7b models were asked for `pcm` as the portal does, with the 26-word sentence
also used for Fish. Memory is read while the model answers again.

| Request | Beside | First, the model starts | Again | GPU memory in use | Lowest free memory |
|---|---|--:|--:|--:|--:|
| qwen3-tts-1.7b, voice ryan, 7.1 s of speech | the LLM | 5.3 s | 2.8 s, 2.8 s | 103.5 GiB | 18.3 GiB |
| qwen3-tts-1.7b, voice ryan, 24.6 s of speech | the LLM | 12.2 s | 9.7 s | 105.9 GiB | 15.9 GiB |
| qwen3-asr-1.7b, 34.6 s recording, WER 1.2% | the LLM | 4.9 s | 2.3 s, 2.3 s | 101.3 GiB | 20.2 GiB |
| qwen3-tts-1.7b-clone, a 12.5 s reference with its text, 7.4 s of speech | SOV | 6.3 s | 3.1 s | 96.6 GiB | 21.5 GiB |
| qwen3-tts-1.7b-design, a described voice, 8.2 s of speech | SOV | 5.8 s | 3.3 s | 96.3 GiB | 21.8 GiB |
| qwen3-asr-1.7b, 34.6 s recording, WER 1.2% | SOV | 4.9 s | 2.3 s | 94.1 GiB | 23.9 GiB |
| qwen3-asr-1.7b, 302.9 s recording, WER 2.8% | SOV | | 25.0 s | 94.2 GiB | 23.7 GiB |

- The journal shows gufo-tts and gufo-asr each started once for their three requests and stopped only when the
  other replaced it. The swaps from the LLM to SOV and back left the speech model running. llama-swap unloaded
  qwen3-tts-1.7b at 15:58:13.6, 300.9 s after its last answer, and logged "TTL of 300s reached".
- A chat request sent 2 s into the 24.6 s speech answered in 0.09 s. The speech took 9.7 s, as it does alone.
- SOV started from the LLM in 88.8 s with qwen3-tts-1.7b beside it. The LLM came back from SOV in 19.1 s with
  qwen3-tts-1.7b still there.
- Eight 302.9 s recordings on SOV with a 24.6 s qwen3-tts-1.7b request 15 s in: 99.0 GiB in use at most and
  18.5 GiB free at least. The transcriptions took 105.2-106.7 s each instead of 95.1-97.3 s, and the speech 20.7 s
  with its model's start instead of 12.2 s. This and the long speech beside the LLM (15.9 GiB free) left the least
  free memory seen with a speech model.
- In an earlier run beside the LLM, the first request took 5.6 s for voice vivian with an instruction (8.2 s of
  speech), 6.0 s for the clone, 5.6 s for the design model and 27.4 s for qwen3-asr-1.7b on the 302.9 s recording
  (WER 2.8%).

That earlier run, without `persistent`, found llama-swap stopping the speech model 5 ms after every answer beside
the LLM, so each request started it again. A request to a model of an exclusive group stops the models of the
other groups, also when that model already runs. The portal's live view asks the LLM for `/slots` every 500 ms
through llama-swap, about two requests a second here. The next request to Fish, ACE or SOV stopped the speech model
in the same way. With `persistent`, only the swaps between the LLM and SOV were checked.

| Speech model started beside (earlier run) | Request | Time | GPU memory, all | Lowest free memory |
|---|---|--:|--:|--:|
| Fish | qwen3-asr-1.7b on Fish's 7.8 s of speech | 3.0 s, WER 0 | 24.3 GiB | 94.3 GiB |
| ACE | qwen3-asr-1.7b, 34.6 s recording | 4.7 s, WER 1.2% | 27.6 GiB | 91.2 GiB |

The outputs that were transcribed came back word for word (WER 0): ryan, the clone and the design voice by
qwen3-asr-1.7b; the 24.6 s ryan speech, Fish's own voice and Fish's clone by SOV. qwen3-asr-1.7b heard the lyrics
of the ACE base track word for word and got 4 of the turbo track's 30 words wrong ("mondo" for "morning",
"Focusing" for "Take it easy"). Nobody listened to the tracks, so whether turbo sang those words less clearly is
not known. Median voice pitch: the reference speaker 127 Hz; Fish's own voice 191 Hz and its clone 128 Hz; ryan
140 Hz, vivian asked to sound cheerful 270 Hz, the Qwen3-TTS clone 119 Hz, the described "deep, older narrator"
98 Hz.

### SOV-Transcribe-1 and its cache

vLLM takes all the memory it is allowed for its KV cache. At `--gpu-memory-utilization 0.85` that was 51.9 GiB, room
for 11.9 requests of 32K tokens, and SOV used 105.8 GiB of the GPU's 124. `llm-server/vllm-sov.container` now caps the
cache with `--kv-cache-memory-bytes` at 36 GiB, room for 8.27 such requests, a little more than its eight sequences
need. vLLM's log gives 7,525 tokens a GiB.

| | 0.85 of the GPU | Cache capped at 36 GiB |
|---|--:|--:|
| KV cache | 51.9 GiB, 390,757 tokens | 36.0 GiB, 270,865 tokens |
| GPU memory, loaded | 105.1 GiB | 88.8 GiB |
| GPU memory at most, eight 302.9 s recordings at once | 105.8 GiB | 89.4 GiB |
| Lowest free memory, the same | 11.9 GiB | 28.4 GiB |
| Start, first 12.5 s transcribed | 97.8 s, the LLM stopped first | 86.2 s, nothing loaded |
| 12.5 s recording | 0.56 s, WER 0 | 0.56 s, WER 0 |
| 34.6 s recording | 1.51 s, WER 0 | 1.51 s, WER 0 |
| 302.9 s recording | 44.3 s, WER 2.9% | 44.3 s, WER 2.9% |
| Eight 34.6 s recordings at once | 3.2 s | 3.0 s |
| Eight 302.9 s recordings at once | 97.3 s, WER 2.7-2.9% | 97.3 s, WER 2.7-2.9% |

- vLLM sees about 2.6 GiB less free memory than the GTT counter shows (121.5 against 124.0 GiB with nothing loaded,
  25.4 against 28.1 beside the LLM). The unit waits for 90 GiB of GTT and vLLM checks for 0.70 of the 124 GiB.
- SOV answers 400 to `response_format` `srt` and `vtt` (vLLM 0.32.0 takes only `text`, `json`, `verbose_json` and
  `diarized_json`) and to `verbose_json` and `diarized_json` (not supported for this model). `text` answers with
  JSON, `{"text": ...}`.

### MiniMax H3

Five-second videos of the same prompt, seed 42, as the portal asks for them (`/upstream/minimax-h3/v1/videos`,
then its status every 5 s and `/content`). Every file is H.264 at 24 frames a second, 124 frames, with stereo AAC
at 32 kHz, 5.18 s long.

| Video | Steps (Gufo's log) | Create to downloaded | GPU memory at most | File |
|---|--:|--:|--:|--:|
| 512 × 512, `fast`, the Turbo image model loaded before | 19 | 220.9 s | 34.3 GiB | 945 KB |
| The same again | 19 | 205.3 s | 34.3 GiB | 945 KB |
| 512 × 512, `exact` (the default) | 49 | 1,056 s (17.6 min) | 39.3 GiB | 893 KB |
| 512 × 512, `exact`, starting on a Turbo image (`first_frame`) | 49 | 1,101 s (18.3 min) | 39.5 GiB | 914 KB |
| 1344 × 768, `exact` | 25 of 49 | cancelled after 40 min | 41.8 GiB until then | |

- At 1344 × 768 the first step ended 107 s after the job started, then each step took 95.4 s (steps 1 to 25 in
  Gufo's log), six times a 512 × 512 step (15.9 s). The job was cancelled after 40 minutes at progress 45%. At that
  rate the steps would end after about 78 minutes; with the decoding scaled up from 512 × 512 by the number of
  pixels, the video would take about 95 minutes (estimate, not run).
- Cancelling that job with `DELETE /v1/videos/{id}` answered `deleted` and the job then answered 404, but the job
  went on: Gufo logged no cancellation and left its folder as `in_progress`. Seen once, on November 27, 2026:
  Gufo's documentation says a `DELETE` cancels the job, and it was not tested again. When llama-swap stopped H3
  27 s later, the container ignored SIGTERM and podman killed it after 10 s; the Gufo quadlets now set
  `StopTimeout=50`. The folder was deleted by hand, so the job could not start again with H3.
- H3's `POST /v1/videos` answers 202. When llama-swap stopped H3 at the start of a 5 s job, Gufo cancelled the
  running job, but a second job queued behind it stayed in the jobs folder as `queued` (Gufo keeps jobs across
  restarts). It was deleted by hand before H3 started again, so whether it would have run was not seen.
- `progress` counts the denoising steps up to 80%, then the video decoding up to 89%, then jumps to 100. With
  `exact`, 10% comes after 5 s, then about 1.5% every 15 s; 80 to 89% takes 4 minutes.
- Lowest free memory was 82 GiB at 512 × 512 and 73 GiB at 1344 × 768.
- What the frames show (15 frames, one every 0.42 s, looked at): `fast` and `exact` both show the prompt, a red fox
  trotting through snow among birches while the camera tracks it from the side. Its body and legs stay whole from
  frame to frame and the light is the low golden light asked for; the steaming breath does not show. With
  `first_frame` the video starts on the picture and the fox walks toward the camera until its head fills the frame;
  two small grey specks appear on the snow for about a second.
- The sound is quiet: mean level -37 dB (`fast`), -43 dB (`exact`) and -44 dB (`first_frame`). In the spectrograms
  `fast` shows short transients and tonal bands, `exact` a low rumble and one call with harmonics, `first_frame`
  regular footstep-like clicks and calls at 0.8 s and 4.5 s. Nobody listened to them.

### Fish Audio Drama 3

Measured on November 27, 2026 through llama-swap v277: fish-speech 3.0.0-beta on PyTorch 2.15.0+rocm10.0
(`llm-server/media/fish-speech.service`), the weights `fishaudio/drama-3` at revision 78e5ab7, seed 42, one request
at a time, no reference voice unless the row names one. Times run from sending the request to the whole answer.

| Request | Speech made | Time, loaded |
|---|--:|--:|
| A short text | 5.6 s | 16.3 s |
| A text with the tags `[whisper]`, `[laughing]` and `[excited]` | 7.1 s | 20.4 to 20.6 s |
| 64 words, made in two chunks | 24.8 to 25.8 s | 71.9 to 75.9 s |
| A cloned voice: a 4.6 or 5.6 s reference with its text | 4.9 to 5.5 s | 16.8 to 17.8 s |

- About 2.9 s for each second of speech. With the swap from the LLM the first text took 48.8 s, both times. The
  server is ready about 33 s after its start. The swap back to the LLM took 17.6 s.
- GPU memory: 72.4 GiB loaded, 76.0 GiB at most, so the unit waits for 78 GiB. fish-speech's documentation says
  "Drama 3 runs on NVIDIA GPUs only: CPU, Apple MPS and AMD ROCm are not supported" and asks for at least 48 GB
  with the FP8 experts. On gfx1151 the FP8 kernels are missing: fish-speech then picks dequantized experts on its
  own and loads them as BF16, which runs.
- The tags were not spoken. Qwen3-ASR heard the three texts and the clone word for word.
- The same seed again: the two short texts were byte-identical in three runs, across restarts of the server; the
  long one in two runs of three.
- With PyTorch's TunableOp on, as `/etc/ai-studio/cache.env` sets it, the three texts took 25.9, 33.2 and
  163.9 s: the unit unsets `PYTORCH_TUNABLEOP_ENABLED`.
- S2-Pro on the same texts the same day: 8.2 s of speech in 17.6 s and 23.8 s in 52.8 s, 2.1 to 2.2 s for each
  second of speech, in 22.5 GiB. Drama 3 is about a third slower and takes 3.4 times the memory. It replaced
  S2-Pro because it is the newer and more capable model and both gave word-perfect speech here. No listening test
  by a person was done.
- The weights take 43 GB on disk.

### Agent turns with the media models

Four turns of OpenCode 2.4.2 in one Private workspace on the test servers, November 27, 2026, each one prompt in
plain words, nobody else on the AI server. Times run from the prompt to the last reply, to within 2 s.

| Asked for | What the agent did | Time |
|---|---|--:|
| A picture, then the same picture with one colour changed | One `generate_image` in an `execute` script with no model named, so Ming-Image made it; then one with `images`, which went to Turbo. Both files saved and shown in the reply | 166 s |
| Three quick wide draft thumbnails | One script with three calls in `Promise.all`, each naming `portal/Qwen-Image-2.1-Turbo#1344x768`. Turbo was loaded once and ran for 62 s; the three files are 1344 × 768 | 113 s |
| Two lines of a radio play "in the best quality", one whispered, one excited | Two `synthesize_speech` calls in one message with `[whisper]` and `[excited]`. Drama 3 was loaded once and ran for 52 s; the agent then transcribed both lines and found every word | 111 s |
| One quick draft video clip, "the shortest length you can" | One `generate_video` in the fast tier, 5 s at 512x512. MiniMax H3 made the 5.2 s clip; the agent cut three frames from it with ffmpeg and showed them | 274 s |

- In the third turn the agent first asked the quality tier for a built-in voice and then for a described one. The
  tool refused both at once, with no model swap, but the two rounds are in the time. The tool's description was
  then changed to say what each tier takes, and the media skill to say how one speaker keeps one voice. The same
  prompt again, on the rebuilt image: no refused call. The agent made a sample with a built-in voice in the fast
  tier and gave it to both quality lines as `reference_audio`; 157 s, the sample and two transcriptions included.
- After the fourth turn the agent wrote that it could not look at the frames. It can: asked to in a next turn, it
  opened a frame with `read` and described the teapot, the steam and the window behind it. The media skill said
  "open" the images and frames; it now names `read`.

### Requests at once

Measured on November 27, 2026, straight at llama-swap with nobody else on the server. Each model was loaded
first, and the requests of a cell were sent at the same moment. Times run from sending to the whole answer, for a
video from creating the job to its end.

| Model and request | One alone | Sent together |
|---|--:|---|
| Qwen-Image-2.1-Turbo, 1024 × 1024 | 18.3 s | Two: 18.4 and 36.7 s. Three: 18.5, 36.9 and 55.3 s |
| The same, as one request with `n` | | `n` 2: 37.0 s. `n` 4: 74.6 s |
| Ming-Image, 1024 × 1024 | 30.5 s | Two: 30.5 s, and an HTTP 502 after 0.0 s (a fault, fixed: below) |
| Qwen3-TTS, a line of about 10 s | 3.9 s | Two: 3.9 and 7.7 s. Four different lines: 5.7, 9.5, 14.1 and 18.8 s |
| Qwen3-ASR, a 17.2 s recording | 1.2 s | Two: 1.2 and 2.4 s. Four: 1.2, 2.4, 3.6 and 4.8 s |
| ACE-Step turbo, 30 s track | 2.7 s | Two: 2.7 and 5.7 s |
| ACE-Step base, 30 s track | 14.6 s | Two: 14.7 and 29.5 s |
| Fish Audio Drama 3, about 13.3 s of speech | 37.9 s | Two: 40.6 and 78.5 s |
| MiniMax H3, 5 s at 512 × 512, `fast` preset | 221 and 201 s | Two jobs created together: 206 and 407 s |
| SOV-Transcribe-1, a 34.6 s recording | 1.51 s | Eight: all answered within 3.0 s |

- **Every model but SOV makes one thing at a time.** A second request waits inside the model's server and is
  answered as late as if it had been sent after the first. SOV runs under vLLM with `--max-num-seqs 8` and
  transcribes eight recordings together.
- **A second copy of a model gains nothing: the GPU is the limit.** Two Turbo containers with one image each
  ended after 38.3 s both, with 63.4 GiB in use, where one container makes two images in 36.7 s. Two Qwen3-TTS
  containers: 7.3 and 7.4 s, against 3.9 and 7.7 s from one. Two Qwen3-ASR containers: 2.2 s both, against 1.2 and
  2.4 s.
- **Gufo has sessions for the LLM only.** `gufo serve image`, `tts` and `asr` answer `--sessions 2` with
  `Error: Unknown option: --sessions`; `gufo serve video` takes it and logs `sessions=1 queue_capacity=1`.
- **ACE-Step in batches**, with its Python API outside the server, `batch_size` 1, 2 and 4. Turbo, 30 s tracks:
  2.7, 4.3 and 8.1 s, so 2.0 s a track in a batch of four; 180 s tracks: 14.7, 27.9 and 54.8 s. Base, 30 s tracks:
  14.8, 29.9 and 62.4 s; 180 s tracks: 117.1, 232.7 and 465.2 s, no faster a track. GPU memory stayed between 22.8
  and 23.5 GiB. The server keeps one track per request: the gain is turbo's alone, and at most 0.7 s a track.
- **The everyday speech models swap among themselves.** With Qwen3-TTS loaded, a first request for the voice
  design model took 6.2 s and the next 3.8 s; a first transcription 3.8 s and the next 1.2 s. Sent together: speech
  and voice design 4.8 and 11.2 s, speech and a transcription 6.3 and 10.1 s.
- **Ming-Image's 502.** Its server counted each prompt's tokens with the model's own tokenizer, outside the lock
  that lets one image be made at a time. A second request did that while the first one's image was being made,
  the tokenizer raised `RuntimeError: Already borrowed`, the request's thread ended, and llama-swap answered 502.
  The server now counts with a copy of the tokenizer. With it, two requests sent together were answered after 30.5
  and 60.8 s, three after 30.6, 60.9 and 91.4 s, each with its image.
- **llama-swap serves the loaded model's requests first**, however many keep coming. A 2,500-token answer in
  progress ended after 61.0 s before the image asked for at 5.0 s was made, by 87.9 s. Three images and three chat
  requests sent in turn: the three images came first, after 28.0, 46.4 and 64.8 s, then the three answers, after
  95.4 to 95.9 s. Twelve chat requests, one every 3 s, with an image asked for at 2.0 s: the image was made last, by
  78.3 s, after the last answer at 51.5 s. With agents at work an image could wait without end, so the portal's
  gateway gives each model its turn itself ([architecture](ARCHITECTURE.md#service-api)).
- **Through the portal's gateway**, the same evening with one API key, 4 requests at once and 3 a user. The same
  twelve chat requests of 300 tokens with a Turbo image asked for at 2.0 s: the first answer ended at 6.9 s, the
  image came next, at 33.8 s, and the eleven other answers between 62.7 and 98.4 s. The image no longer waits for
  the chat requests to stop coming, and they pay for its two swaps instead.
- **Speech while the LLM's sessions are busy.** Five chat requests of 900 tokens from one user, so three ran and
  two waited in the gateway's queue, then a Qwen3-TTS request at 3.0 s: it was answered at 9.6 s, its model's
  start included, while the first chat answer ended at 29.6 s and the last at 63.7 s. The live view showed four
  sessions, three of the LLM and one marked as beside it, and two requests waiting.
- **A model on the wrong address** was refused with HTTP 400 after 1 to 3 ms, and llama-swap kept the LLM loaded:
  Ming-Image on `/v1/images/edits`, an image model on `/v1/chat/completions`, the transcription model on
  `/v1/audio/speech`, a speech model on `/v1/images/generations`.

### Fish S2-Pro and ACE-Step

The two Fish rows are S2-Pro's, from before Drama 3 replaced it: S2-Pro is no longer installed.

| Request | Time, loaded | With the swap | Output | GPU memory |
|---|--:|--:|---|--:|
| Fish, its own voice, 26 words | 16.5 s | 53.5 s from H3 | 7.8 s, 44.1 kHz mono WAV | 19.2 GiB, 20.3 at most |
| Fish, a cloned voice: 12.5 s reference with its text | 18.4-19.2 s | | 7.8 s | 21.7 GiB at most |
| ACE turbo, 8 steps, 30 s with lyrics | 3.0 s | 29.7 s from SOV | 30.0 s, 48 kHz stereo WAV | 22.4 GiB, 24.5 at most |
| ACE base, 50 steps, the same | 15.1 s | 39.1 s from Fish | 30.0 s, 48 kHz stereo WAV | 24.4 GiB at most |

- S2-Pro took about 2.1 seconds for each second of speech.
- The model name picks ACE's model: its log shows the turbo settings for every `acestep-1.5-xl-turbo` request,
  sent to `/upstream/acestep-1.5-xl-turbo/` (llama-swap's alias), and the base settings for `acestep-1.5-xl-base`.
- Both tracks are peak-normalized to -1 dB, mean level -16.5 dB (turbo) and -19.6 dB (base). Their spectrograms
  show notes and a sung voice; the last second of each is near silence.

## Portal server

### Workspace memory

Qwen Code's process grows to about 1.9 GB on its first tool call and then falls back to about 300 MB. The 8 GB
machine has about 6.3 GB free with the portal and search running.

| Workspaces and limit | Result |
|---|---|
| 1.25 GiB each | Every agent was killed. |
| 2 GiB each, four agents | Ran for 21 minutes without a kill. |
| Two at 2.25 GiB plus 512 MiB of swap each | About 1 GB left with both filled to the limit. |
| Three at 2 GiB | A realistic run finished with 2.8 GB to spare. In the pinned worst case free memory fell to 13 MB and the kernel killed a workspace process. |
| Three at 2.25 GiB | In use since November 18, 2026. Not measured with Qwen Code: its worst case is that of the row above. |

With more RAM, count about 2.75 GiB per workspace.

OpenCode 2.4.1 in three workspaces of 2.25 GiB, during the 51 turns under [OpenCode](#opencode):

- A workspace that has just started holds about 300 MiB. OpenCode's own process has 150 MiB then and 290 to
  395 MiB while it works (434 at most), the same with 20,000 tokens of conversation as with 208,000.
- Without the file cache, a working workspace held at most 364 to 915 MiB, depending on the work. The 915 MiB
  were the one whose agent opened its page in the workspace's Chromium (883 MiB) and ran a Go test under the
  race detector (567 MiB). g++ took 408 MiB, the Go compiler 170 and rustc 147.
- With the file cache, that same workspace peaked at 2,297 MiB, 7 below its limit; 1,224 MiB of it were file
  cache at its end. The kernel counted no hit of the limit and killed nothing. The six other runs of a
  workspace peaked at 398 to 857 MiB.
- The machine kept at least 4,306 MiB available while three workspaces worked, and 4,056 MiB while two worked
  and the one with Chromium was among them. Swap use did not change.

### OpenCode

OpenCode 2.4.1, November 24, 2026, Gufo 0.36.0: 51 turns in six conversations in Private workspaces, sent
through OpenCode's own API inside each workspace, with its page closed. The tasks were small projects in Go,
C++, Rust, Python, Bash and PowerShell, each built and tested by the agent.

- The gateway passed 500 model requests and none failed. 50 turns succeeded; the one that failed was made to
  (the cut-off below). No turn waited for an approval or a question.
- Of 473 tool calls, 6 edits failed because their old text was not in the file, and the agent repeated each.
  2 more were the cut-off's.

One long conversation, alone:

- 21 turns. After the fourth the workspace was left alone and stopped for idleness. Started again 40 minutes
  after that turn, the conversation went on with its 61,320 tokens.
- Reads of 2,000 lines of Go's own source added up to 26,000 tokens each, until the conversation had 207,733.
  On the next turn OpenCode shortened it by itself, to 20,345 tokens; that turn took 44 seconds. This fits a
  limit of the window less the reply limit (262,144 − 64,000 = 198,144 tokens), which is an estimate:
  OpenCode's rule was not looked up.
- Afterwards the agent still named two facts from the first turn that were in no file, and worked on for 8
  turns. The tests of both projects passed at the end.
- The first word came after 0.2 to 5 seconds when only the prompt was new, after 15 to 17 seconds behind 25,000
  new tokens, and after 28 seconds when 72,745 tokens were read again after the restart. The gateway counted
  1,594 tok/s reading.

Three workspaces at once:

- Three conversations worked at the same time for 13 minutes and two for 17 more. Every turn succeeded.
- A turn took 3.5 seconds to 11.4 minutes. The longest was the first after a restart, with 79,689 tokens to
  read again and 62 seconds to the first word.
- Writing, per conversation, as the gateway counted it: 61 to 65 tok/s alone, 48 with two at once, 37 to 45
  with three.
- One agent had a subagent review its code in the background and looked at its own page with the browser
  tools; the review came back two turns later.
- A workspace used 0.03 to 0.10 of a core on average: most of a turn is the model's time.
- The AI server did not restart and no session waited for memory (`gufo_shared_state_waits_total` stayed 0).

A reply cut off at its limit. Asked for 30,000 lines of numbers, the model declined and gave a command
instead, so the cut-off was forced: one workspace got a reply limit of 1,500 tokens.

- A plain answer: OpenCode tells the model that its answer hit the limit and lets it go on, twice. The third
  cut-off ends the turn as failed (`Response still truncated after two output token limit continuations`). The
  three parts stay in the conversation, and "continue" as the next prompt finished the text.
- A tool call cut off inside its arguments is not run, and the model is told to send smaller pieces. Asked for
  a file of 2,000 lines in one call, it was cut off twice and then wrote the file in 20 pieces. The file was
  complete after 219 seconds.

### Web search

- 30 searches, one every 20 seconds: none came back empty and each took a second or less.
- About one query a second got the test address blocked by Brave and DuckDuckGo for over an hour.
- Keenable returns a passage of each page instead of a one-line snippet and allows 1,000 searches an hour from
  one address without a key, but it has no page 2 and no date filter. Yahoo and Yandex have both and
  MetaCrawler has page 2.

| Engine left out | Why |
|---|---|
| `google` | Answers 403. |
| `startpage` | Answers a CAPTCHA. |
| `bing` | Searches only the first word. |
| `brave` | Answers "too many requests" after about ten searches. |
| `wikipedia` | Needs a contact address in this SearXNG version. |
| `google cse` | Needs a Google key. |

### Page reader

- 29 public pages on the 2-core machine: 26 were read in 0.2 to 3.8 seconds each. Stack Overflow, npm and
  Reddit could not be read.
- Tested with one agent of each kind and with six pages at a time.

### portal-hostd

- While someone has Admin > Usage open: about 1 ms of CPU per reading, 0.2% of one core and 25 MB of RAM.
- The rest of the time it adds up energy and traffic, one read every 2 seconds: under 0.05% of one core.
- The per-session speeds come from Gufo's `/slots` and the answers the portal already passes on, so the model
  does no extra work.

### Portal pages

Every page in Chrome with touch emulation at 320 to 1,920 pixels wide: nothing scrolls sideways and every
button is at least 40 pixels under a finger. Not tried on a real phone or with a screen reader.
