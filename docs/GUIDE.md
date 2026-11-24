# Strix Halo local agent server

Sets up a Strix Halo machine as a coding-agent server: Qwen3.8-Flash-Next on the Gufo engine with four 256K
sessions, and Workspace Portal on a second machine for the agents. Each step is a command, what it does and what
you should see.

**Tested on November 18, 2026** on one Bosgame M5 (Ryzen AI Max+ 395, 128 GB, board AXB35-02, BIOS 3.11) and a
2-core Pentium with 8 GB. The measurements behind the settings are in [MEASUREMENTS.md](MEASUREMENTS.md); what was
not tried is listed under [Not tested](#not-tested).

| Sessions | Writing speed | Reading speed | GPU memory |
|---|---|---|---|
| **4 × 256K**<br>262,144 tokens each, shared by all users and subagents | **51-79 tok/s**<br>one user, most often about 65; about 20 each with four at once | **1,780 tok/s**<br>prompt processing, machine hot, fan curve on | **124 GiB**<br>of 128 installed, after the unlock in step 5 |

## The two machines

The Strix Halo machine runs the model and nothing else. A small second PC runs the agents, their sandboxes and web
search, so nothing competes with the model for memory.

| | What it is | Reached |
|---|---|---|
| **A browser, or your own software** | | on your LAN, or on your tailnet over HTTPS |
| **Portal server** | Workspace Portal: two sandboxed Qwen Code, DeepSeek Harness or OpenCode workspaces per person, Private and Online, with SearXNG search and a page reader, plus the model's API behind each person's own keys | from the browser, on port 3000 or 443 |
| **LLM server** | The Strix Halo machine: Gufo serving Qwen3.8-Flash-Next with vision | from the portal server only, on port 8080 |

<details>
<summary>No second machine?</summary>

**API only.** Skip part 3 and use the model from your own PC through an SSH tunnel. Any OpenAI-compatible client
then talks to `http://127.0.0.1:8080/v1`.

**Your PC**:

```sh
ssh -N -T -o ExitOnForwardFailure=yes -L 127.0.0.1:8080:127.0.0.1:8080 YOUR_LOGIN@LLM_IP
```

**Agents on the LLM server itself** are not set up in this guide. Use the 3 × 256K layout from [step 8](#layouts);
it was not tried with busy sandboxes next to the model. Free memory in each layout:
[MEASUREMENTS.md](MEASUREMENTS.md#memory).

</details>

## Before you start

- **The LLM server:** a Strix Halo machine (Ryzen AI Max+ 395) with 128 GB. [Step 7](#7-fans-and-power-profile),
  fans and power profile, runs on the tested board and BIOS only.
- **A second PC** for part 3: any x86-64 machine with 8 GB of RAM.
- **A USB stick** with [Fedora Server](https://fedoraproject.org/server/download/) for both machines, and your own
  PC with SSH. The LLM server was measured on [Fedora
  44](https://dl.fedoraproject.org/pub/fedora/linux/releases/44/Server/x86_64/iso/); the portal server runs 45.
- **Time:** about an hour of typing, plus a 141 GB download (62 minutes at 38 MB/s).

The commands use three placeholders. Put your own values in their place: `LLM_IP` and `PORTAL_IP`, the addresses of
the two servers, and `YOUR_LOGIN`, your login on both.

The line above each command block says where to run it: **Both servers**, **LLM server**, **Portal server** or
**Your PC**.

## Part 1: Both servers

A fresh Fedora Server on each machine. Steps 1 to 3.

### 1. Install Fedora Server

*At each machine · about 30 min each*

1. **BIOS, LLM server only.** Tap <kbd>Del</kbd> at power-on. Set **Security > Secure Boot** to Disabled, because
   the self-built fan driver of step 7 does not load with it on, and **Advanced > Auto Power On** to Power On, so
   the machine comes back after a power cut. Save with <kbd>F4</kbd>. Other vendors name these menus differently.
2. **Install.** Boot the Fedora Server stick with Ethernet plugged in. Set your time zone, create an administrator
   account and install to the whole SSD.
3. **Find the address.** Log in at the console, note the address, and reserve it in your router so it never
   changes: the firewall rules and the portal's settings use it.

**Both servers**:

```sh
ip -4 addr
```

> **Do not flash another BIOS** on the tested board: the fan control of step 7 is tied to 3.11, and a failed flash
> needs a hardware programmer to recover.

<details>
<summary>Root filesystem only 15 GB? Grow it first</summary>

Fedora Server's automatic layout can give you a 15 GB root inside LVM and leave the rest of the SSD unused. Check
on both machines:

**Both servers**, check:

```sh
df -h /
lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINTS
```

**LLM server:** grow the root to 200 GB and put the rest of the disk into `/models`, where the 141 GB of model
files go:

**LLM server**, only for a small LVM root:

```sh
ROOT_LV=$(findmnt -no SOURCE /)
VG=$(sudo lvs --noheadings -o vg_name "$ROOT_LV" | tr -d ' ')
sudo lvextend -r -L 200G "$ROOT_LV"
sudo lvcreate -y -n models -l 100%FREE "$VG"
sudo mkfs.xfs -L models "/dev/$VG/models"
sudo mkdir -p /models
echo 'LABEL=models /models xfs defaults,noatime 0 0' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload
sudo mount /models
sudo chown "$USER": /models
```

**Portal server:** give the root everything. The portal keeps its images and every user's files there.

**Portal server**, only for a small LVM root:

```sh
sudo lvextend -r -l +100%FREE "$(findmnt -no SOURCE /)"
```

</details>

### 2. Base system

*Both servers · 1 reboot*

Updates Fedora and installs the tools the rest of the guide uses. Makes sure SSH, the firewall, the clock sync and
the weekly SSD trim are on.

**Both servers**:

```sh
sudo dnf upgrade --refresh -y
sudo dnf install -y openssh-server firewalld chrony dnf5-plugins curl git smartmontools
sudo systemctl enable --now sshd firewalld chronyd fstrim.timer
sudo reboot
```

**Both servers**, after the reboot:

```sh
cat /etc/fedora-release
systemctl is-active sshd firewalld chronyd
timedatectl show -p Timezone -p NTPSynchronized
systemctl --failed --no-legend
```

**You should see** the Fedora release, `active` three times, your time zone with `NTPSynchronized=yes`, and nothing
after that. Right after the reboot the clock may still say `no`; repeat the command a minute later. Every further
line is a service that failed to start; `systemctl status NAME` says why.

#### Log in with a key, then switch passwords off

Copies your SSH key to both servers and proves that the key alone gets you in.

**Your PC**:

```sh
[ -f ~/.ssh/id_ed25519.pub ] || ssh-keygen -t ed25519
for h in LLM_IP PORTAL_IP; do ssh-copy-id YOUR_LOGIN@$h; done
for h in LLM_IP PORTAL_IP; do
  ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no YOUR_LOGIN@$h true && echo "$h: key works"
done
```

Only after both lines say `key works`: refuse password and root logins from now on.

**Both servers**:

```sh
printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' \
  | sudo tee /etc/ssh/sshd_config.d/00-keys-only.conf
sudo sshd -t && sudo systemctl reload sshd
```

### 3. Firewall

*Both servers*

Fedora Server's firewall is on from the first boot and lets in SSH and the web console. This shows what is open and
closes the web console, which this guide does not use.

**Both servers**:

```sh
sudo firewall-cmd --get-default-zone
sudo firewall-cmd --list-services
sudo systemctl disable --now cockpit.socket
sudo firewall-cmd --permanent --remove-service=cockpit
sudo firewall-cmd --reload
sudo firewall-cmd --list-all
```

**You should see** `FedoraServer`, the open services `cockpit dhcpv6-client ssh`, `success` twice, and a zone whose
list no longer names the web console:

```text
  services: dhcpv6-client ssh
  ports:
```

If the first line names another zone, such as `public` on a minimal install, use that name where [step
8](#8-start-the-model) says `FedoraServer`. The rules for the model and the portal come with steps 8 and 11.

<details>
<summary>Opening a port yourself, and keeping the web console</summary>

Open it to the one address that needs it, never to everyone. `--permanent` writes the rule to disk and `--reload`
applies it; without `--permanent` the rule is gone after the next reboot.

**Both servers**, example: port 8080 for one address:

```sh
sudo firewall-cmd --permanent \
  --add-rich-rule='rule family="ipv4" source address="192.0.2.10/32" port port="8080" protocol="tcp" accept'
sudo firewall-cmd --reload
sudo firewall-cmd --list-rich-rules
```

To take it back, repeat the first command with `--remove-rich-rule`, then reload. A whole network is written as
`192.168.1.0/24`.

The web console shows updates, logs and disks in a browser at `https://ADDRESS:9090`. To keep it, skip the third
and fourth line of the step's block; to bring it back, `sudo systemctl enable --now cockpit.socket` and
`--add-service=cockpit`. More in Fedora's [firewalld
guide](https://docs.fedoraproject.org/en-US/quick-docs/firewalld/).

</details>

### Keep them updated

*Both servers · once a month*

Nothing updates itself on either server. Pick an hour when nobody is working, then on each one:

**Both servers**:

```sh
sudo dnf upgrade --refresh -y
dnf needs-restarting -r
```

The second command says whether the update needs a reboot. If it does, `sudo reboot`. Then look the machine over:

**Both servers**, health check:

```sh
systemctl --failed --no-legend
df -h / | tail -1
sudo journalctl -k -p err -b --no-pager | tail -20
sudo bash -c 'smartctl --scan | cut -d" " -f1 | xargs -n1 smartctl -H | grep result'
```

**Good:** no failed service, room left on the disk, no hardware errors from the kernel, and `PASSED` for every
disk. Four kernel lines on the LLM server are not hardware errors: `virt/tdx: TDX not supported by the host
platform`, and three from `amdxdna`, the driver of the NPU, which is not used here and cannot start once step 5 has
turned the IOMMU off (`Running without IOMMU not supported`, `Hardware init failed, ret -22`, `probe ... failed
with error -22`). The portal test machine, an old PC without a TPM, prints the TDX line too, and `DMAR: [Firmware
Bug]`, `SGX disabled or unsupported by BIOS` and `ima: Error Communicating to TPM chip`: features it lacks, not
faults.

The LLM server has its own checks [after a reboot](#day-to-day) and [after a kernel update](#engine-update). The
portal comes back by itself and is updated [separately](#update-the-portal).

<details>
<summary>Automatic updates, and a new Fedora release</summary>

Fedora can install updates by itself ([dnf
automatic](https://docs.fedoraproject.org/en-US/quick-docs/autoupdates/)). It is switched off on both test
machines, because an update can restart Docker, which stops every workspace.

A new Fedora release comes out every six months and gets updates for about thirteen. The upgrade is a download and
one long reboot, described in Fedora's [upgrade
guide](https://docs.fedoraproject.org/en-US/quick-docs/upgrading-fedora-offline/). On the LLM server, run the speed
check from [step 9](#9-test-it) again afterwards.

</details>

## Part 2: LLM server

The Strix Halo machine. Steps 4 to 10.

### 4. Tools and CPU profile

*LLM server*

Installs Podman and the monitoring tools, lets containers use the GPU under SELinux, sets the CPU governor to
performance, lets your services start at boot without a login, creates `/models`, and fetches the
[repository](https://github.com/ShahriarDhruvo/workspace-portal) whose `llm-server` folder the next steps run.

**LLM server**:

```sh
sudo dnf install -y podman grubby tuned nvtop jq tmux btop
sudo setsebool -P container_use_devices 1
sudo systemctl enable --now tuned
sudo tuned-adm profile accelerator-performance
sudo loginctl enable-linger "$USER"
sudo install -d -o "$USER" -g "$(id -gn)" -m 755 /models
git clone https://github.com/ShahriarDhruvo/workspace-portal.git ~/workspace-portal
tuned-adm active
cat /sys/class/dmi/id/board_name /sys/class/dmi/id/bios_version
```

**You should see**, as the last lines, the profile, then your board and BIOS. On the test machine:

```text
Current active profile: accelerator-performance
AXB35-02
3.11
```

<details>
<summary>New unit? Burn it in before tuning (optional, about 1.5 hours)</summary>

If a test fails at stock settings the unit is faulty. Return it; tuning would only hide the fault. Run these in
`tmux`, before the model is loaded.

**LLM server**:

```sh
sudo dnf install -y stress-ng stressapptest
# CPU: every core checks its own arithmetic for 30 minutes
sudo stress-ng --cpu 0 --cpu-method all --verify --tz --metrics-brief --timeout 30m
# RAM: fills 108 GB and checks it for an hour (run after step 5, when Linux sees all the RAM)
sudo stressapptest -M 108000 -s 3600 -W
# Hardware errors the kernel noticed
sudo journalctl -k -b -p err --no-pager
```

**Pass:** `stress-ng` reports `passed: 32` and `failed: 0`, `stressapptest` ends with `Status: PASS`, and the
kernel log holds no hardware error; the lines that are harmless on this machine are listed under [Keep them
updated](#keep-them-updated). On stock fans the chip sits at about 98 °C in the CPU test, its own limit, where it
slows itself down, and at about 95 °C in the RAM test.

</details>

### 5. Unlock the memory

*LLM server · 1 reboot*

**UMA.** The test machine ships with 64 GB fixed to the GPU, so Linux sees only about 62 GB. This shrinks the fixed
part to its 512 MB minimum. The GPU borrows what it needs instead.

**LLM server**:

```sh
cat /sys/class/drm/card*/device/uma/carveout_options
echo 0 | sudo tee /sys/class/drm/card*/device/uma/carveout
```

> On BIOS 3.11 the list starts with `0: Minimum (512 MB)`. If your list differs, write the number that stands next
> to Minimum.

**GTT limit and IOMMU.** Lets the GPU borrow up to 124 GiB of RAM and turns the IOMMU off. Then reboot.

**LLM server**:

```sh
sudo grubby --update-kernel=ALL --args="amd_iommu=off ttm.pages_limit=32505856"
sudo reboot
```

**LLM server**, after the reboot:

```sh
cat /proc/cmdline
free -h | sed -n 2p
sudo dmesg | grep -E 'of (VRAM|GTT) memory ready'
cat /sys/class/drm/card[0-9]*/device/mem_info_gtt_total
```

**You should see** both options at the end of the first line, then:

```text
Mem:           124Gi   ...
amdgpu 0000:c5:00.0:  512M of VRAM memory ready
amdgpu 0000:c5:00.0:  126976M of GTT memory ready.
133143986176
```

The small VRAM number is normal: the GPU works out of shared RAM.

<details>
<summary>What each kernel option does, and what IOMMU off costs</summary>

|  |  |
|---|---|
| `ttm.pages_limit=32505856` | The ceiling for GPU-borrowed RAM in 4 KiB pages: 124 GiB. The default is about half the RAM. It is a ceiling, not a reservation, and a higher number adds nothing because Linux only has 124.9 GiB. |
| `amd_iommu=off` | Other owners report 5-15% faster prompt reading on this chip; it was not compared here. The price: the NPU stops working, devices cannot be passed into virtual machines, and anything plugged into USB4 can read memory directly, so connect only devices you trust. |

To get the IOMMU back:

**LLM server**:

```sh
sudo grubby --update-kernel=ALL --remove-args=amd_iommu=off
sudo reboot
```

</details>

### 6. Download the model

*LLM server · about 65 minutes, unattended*

Opens a terminal session that keeps running if your connection drops.

**LLM server**:

```sh
tmux new-session -A -s setup
```

Installs the [Hugging Face CLI](https://huggingface.co/docs/huggingface_hub/guides/cli) into its own Python
environment in your home folder.

**LLM server**, inside tmux:

```sh
python3 -m venv ~/.hf-cli && ~/.hf-cli/bin/pip install --quiet huggingface_hub
```

Fetches Qwen3.8-Flash-Next (Q4) with its n-gram table at 8.5 bits a value, its MTP helper and the vision file from
one fixed revision of Unsloth's repository: seven files, 141 GB. The last line checks each file against the SHA256
the Hub lists for it.

**LLM server**, inside tmux:

```sh
REV=f5d175de2cf7f720d45d6064019a81fcf056e986
~/.hf-cli/bin/hf download unsloth/Qwen3.8-Flash-Next-GGUF --revision $REV --local-dir /models/qwen3.8-flash-next \
    UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-0000{1..3}-of-00004.gguf \
    engram/Qwen3.8-Flash-Next-engram-Q8_0.gguf_file engram/set_split.py \
    MTP/mtp-Qwen3.8-Flash-Next-shared-Q8_0.gguf mmproj-BF16.gguf
~/.hf-cli/bin/hf cache verify unsloth/Qwen3.8-Flash-Next-GGUF --revision $REV --local-dir /models/qwen3.8-flash-next
```

**You should see**, at the end:

```text
Warning: 70 remote file(s) are missing locally. Use --fail-on-missing-files for details.
✓ Verified 7 file(s) for model 'unsloth/Qwen3.8-Flash-Next-GGUF'. All checksums match.
```

The warning only means that the repository holds more than these seven files, such as other sizes of the model.

> Leave it running: <kbd>Ctrl</kbd>+<kbd>b</kbd> then <kbd>d</kbd> detaches, `tmux attach -t setup` returns. Step 7
> can be done while it downloads.

> If the download stops with an error, run its block again: finished files are skipped and the others start over.
> If the check names a file that does not match, delete that file and run the block again. Once the check has
> passed, `find /models/qwen3.8-flash-next/.cache -name '*.incomplete' -delete` removes what a stopped run left.

Puts the n-gram table where the engine looks for the model's fourth file. Unsloth's script first marks it as file 4
of 4.

**LLM server**, once the check has passed:

```sh
cd /models/qwen3.8-flash-next
python3 engram/set_split.py engram/Qwen3.8-Flash-Next-engram-Q8_0.gguf_file 4 4
mv engram/Qwen3.8-Flash-Next-engram-Q8_0.gguf_file UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00004-of-00004.gguf
```

Both lines print nothing. Afterwards the download block would fetch the table again, and the check reports the
fourth file as not matching: the Hub lists Unsloth's own under that name.

> The n-gram table is 51 billion values that the engine reads from the SSD as it needs them. Unsloth's own fourth
> file holds it at 4.5 bits a value in 29 GB; this one holds it at 8.5 bits in 54 GB. With it the model predicts
> Wikipedia text 0.3% better and code the same, as it does with the full-precision table of 102 GB. It takes no
> more memory and is as fast ([measurements](MEASUREMENTS.md#n-gram-table)).

> The model is under the [Qwen Community
> License](https://huggingface.co/Qwen/Qwen3.8-Flash-Next/blob/main/LICENSE). Selling it as a paid AI service needs
> a separate licence; read the text for anything beyond your own use.

### 7. Fans and power profile

*LLM server · tested board only*

Builds the driver for the board's controller chip with DKMS and starts one service. It holds a fan curve that
follows the hotter of CPU and GPU up to 95%, and selects the firmware's Performance profile (120 W sustained, 160 W
peak) whenever it starts. The installer refuses any board or BIOS but the tested one, and a machine with Secure
Boot on; the firmware then keeps the fans.

**LLM server**:

```sh
sudo bash ~/workspace-portal/llm-server/fans/install.sh
```

**You should see**, as the last line:

```text
install.sh: module m5-1, profile performance, fan curve running
```

**LLM server**, check:

```sh
systemctl is-active m5-fans.service
dkms status ec_su_axb35
grep . /sys/class/ec_su_axb35/apu/power_mode /sys/class/ec_su_axb35/fan[12]/rpm /sys/class/ec_su_axb35/fan[12]/duty
```

**You should see**, with your kernel in the second line:

```text
active
ec_su_axb35/m5-1, 7.3.4-200.fc44.x86_64, x86_64: installed
/sys/class/ec_su_axb35/apu/power_mode:performance
/sys/class/ec_su_axb35/fan1/rpm:0
/sys/class/ec_su_axb35/fan2/rpm:0
/sys/class/ec_su_axb35/fan1/duty:0
/sys/class/ec_su_axb35/fan2/duty:0
```

> Duty `0` means the firmware has the fans, which is the case below 60 °C; while the chip is cool they may stand
> still. Under load they get clearly louder than stock. The curve is listed in
> [llm-server/README.md](../llm-server/README.md), what it gains in [MEASUREMENTS.md](MEASUREMENTS.md#fans).

> **Other machines with this board** were not tested: the upstream driver's README lists the GMKtec EVO-X2, FEVM
> FA-EX9, Peladn YO1, NIMO AI MiniPC and Corsair AI Workstation 300. The duty registers this driver writes are not
> part of the upstream driver, so do not edit the board check to get past it.

<details>
<summary>Quieter profiles, and how to undo the step</summary>

| Profile | Sustained / peak | Cost |
|---|---|---|
| `performance` | 120 W / 160 W | Fastest. Used for every number in this guide. |
| `balanced` | 85 W / 120 W | Less heat and noise. |
| `quiet` | 55 W / 100 W | Prompt reading 28% slower. |

Switch live, until the next boot:

**LLM server**:

```sh
echo balanced | sudo tee /sys/class/ec_su_axb35/apu/power_mode
```

To keep another profile across boots, change the word `performance` in `/etc/systemd/system/m5-fans.service`, then
run `sudo systemctl daemon-reload` and `sudo systemctl restart m5-fans.service`. Running the installer again puts
`performance` back.

Undo: removes the driver, the fan curve and its service, and the firmware has the fans again. The power profile
stays as it is, so switch it with the line above first if you want another.

**LLM server**:

```sh
sudo bash ~/workspace-portal/llm-server/fans/install.sh uninstall
```

**You should see**, as the last line, `install.sh: removed; the firmware controls the fans`

</details>

### 8. Start the model

*LLM server*

Pulls Gufo 0.35.0 and installs the service that serves the model with four 256K sessions, MTP and vision. The
service starts at boot and restarts itself after a crash.

**LLM server**:

```sh
podman pull "$(sed -n 's/^Image=//p' ~/workspace-portal/llm-server/gufo.container)"
mkdir -p ~/.config/containers/systemd
cp ~/workspace-portal/llm-server/gufo.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start gufo.service
```

Gufo has no login of its own. This lets the portal server, and nobody else, reach port 8080.

**LLM server**:

```sh
sudo firewall-cmd --permanent --zone=FedoraServer \
  --add-rich-rule='rule family="ipv4" source address="PORTAL_IP/32" port port="8080" protocol="tcp" accept'
sudo firewall-cmd --reload
```

**LLM server**, check:

```sh
journalctl --user -u gufo.service | grep -o 'load_completed.*' | tail -1
curl -s http://127.0.0.1:8080/props \
  | jq -c '{total_slots, build_info, n_ctx: .default_generation_settings.n_ctx, vision: .modalities.vision}'
```

**You should see**

```text
load_completed kind=text elapsed_ms=15936 ... sessions=4 context_tokens=262144 speculative=mtp ...
{"total_slots":4,"build_info":"0.35.0 (0260e11)","n_ctx":262144,"vision":true}
```

> The first block returns once the model is loaded and healthy: after about 2 minutes on the test machine: 99
> seconds for the 3.6 GB image, 17 for the model. Each session has 262,144 tokens, all the model takes, for
> everything: instructions, tools, history, thinking and the answer. Qwen Code asks for replies of up to 64,000
> tokens, and a client that names no limit gets the same (`--max-tokens`). Thinking is part of a reply and ends
> after 32,000 tokens (`--reasoning-budget`), which leaves the other half of a full reply for the answer.
> Summarizing a 93,700-token document took 26,300 tokens of thinking and a 26,000-token answer at the highest
> effort, 390 and 7,500 at `low` ([measurements](MEASUREMENTS.md#replies-and-thinking)).

<a id="layouts"></a>

<details>
<summary>Other session layouts</summary>

Change `--sessions` and `--context` in `~/.config/containers/systemd/gufo.container`, then run `systemctl --user
daemon-reload` and `systemctl --user restart gufo.service`.

| Layout | Flags | Use it when |
|---|---|---|
| **4 × 256K** | `--sessions 4 --context 262144` | Long tasks. The layout of this guide. |
| **7 × 128K** | `--sessions 7 --context 131072` | More people or subagents at once, with shorter conversations. An eighth session is refused at load. |
| **3 × 256K** | `--sessions 3 --context 262144` | Agents on the same machine. |

For another layout, set `LLM_MAX_CONCURRENCY` in [step 11](#11-workspace-portal) to its sessions, and after that
step give the agents its context (here 131072):

**Portal server**:

```sh
cd ~/workspace-portal
sed 's|"contextWindowSize": 262144|"contextWindowSize": 131072|' \
  qwen-config/system-defaults.json > /tmp/system-defaults.json
sudo bash deploy/qwen-config.sh install /tmp/system-defaults.json
```

With 128K sessions also set `--reasoning-budget 16000`: there Qwen Code's replies shrink to 29,000 tokens before it
compacts a conversation. The load test of [step 9](#9-test-it) takes `--users 7 --target 128000` or `--users 3
--target 256000`. Memory and timings of all three layouts are in [MEASUREMENTS.md](MEASUREMENTS.md#memory); replies
of this size were run with four sessions only.

</details>

### 9. Test it

*LLM server*

**Tool call.** Agents depend on these: the model must answer with a call, not with prose.

**LLM server**:

```sh
curl -sS http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model": "qwen3.8-flash-next",
  "messages": [{"role": "user", "content": "What is the weather in Tampa? Use the tool."}],
  "tools": [{"type": "function", "function": {"name": "get_weather",
    "description": "Get the weather for a city",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}],
  "max_tokens": 2048
}' | jq -c '.choices[0] | {finish_reason, tool: .message.tool_calls[0].function}'
```

```text
{"finish_reason":"tool_calls","tool":{"name":"get_weather","arguments":"{\"city\":\"Tampa\"}"}}
```

**Speed.** One streamed answer, with the server's own timing.

**LLM server**:

```sh
curl -sSN http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model": "qwen3.8-flash-next", "stream": true,
  "stream_options": {"include_usage": true},
  "messages": [{"role": "user", "content": "Write a Python function that merges overlapping intervals."}],
  "max_tokens": 512
}' | grep '"timings"' | tail -1 | sed 's/^data: //' \
  | jq -c '.timings | {decode_tok_s: .predicted_per_second, tokens: .predicted_n, draft_accepted: .draft_n_accepted, drafted: .draft_n}'
```

**You should see** 51 to 79 tokens per second, most often about 65:

```text
{"decode_tok_s":64.92572051060347,"tokens":436,"draft_accepted":307,"drafted":364}
```

**Full load.** Sends a 256,000-token prompt into all four sessions at the same moment, makes each one find three
keys in it and pass them to a tool, and watches memory while it runs. The run takes about 11 minutes and occupies
the whole server, so do it before anyone depends on it.

**LLM server**:

```sh
python3 ~/workspace-portal/llm-server/acceptance.py
```

**You should see** one line per session, one line of readings, and both verdicts:

```text
Prompts: 4 of 255997 to 255999 tokens. Sending them all at once.
user 0: first word after 636.2 s, follow-up after 0.9 s: PASS
...
Sessions busy at once: 4 of 4. Lowest free memory: 6.5 GiB. Swap pages moved: 1. Killed for memory: 0. Hottest: 99 °C.
FUNCTIONAL PASS
CAPACITY PASS
```

> For the first three minutes the chip runs at its limit of about 100 °C with the fans at 95%; then it holds 88-89
> °C.

### 10. CPU undervolt

*LLM server · optional · about 30 min*

Lowers the voltage of every CPU core by 50 steps of the chip's voltage curve with
[RyzenAdj](https://github.com/FlyGoat/RyzenAdj). The cores then run cooler and clock higher inside the same power
limit: 9% more work in an all-core test, at 94 °C instead of 98 °C. Prompt reading gains about 1%, because the GPU
does most of that work and has no such setting. Of the clock and voltage settings [tried on this
machine](MEASUREMENTS.md#levers-tried-and-left-alone) it is the only one the firmware accepts. Every chip is
different, and a core with too little voltage miscalculates or freezes the machine. So the offset is first set
until the next reboot, then checked, and only then set at every boot.

**LLM server**:

```sh
sudo dnf copr enable -y shdwchn10/ryzenadj
sudo dnf install -y ryzenadj stress-ng
sudo ryzenadj --set-coall=1048526
```

**You should see**, as the last line; the number is 1048576 minus the offset:

```text
Successfully set coall to 1048526
```

**Check it.** All cores check their own arithmetic for 5 minutes, then each of the 16 cores alone for 30 seconds
(CPUs 0 to 15 are one thread of each), then the full-load test of [step 9](#9-test-it) runs once more.

**LLM server**:

```sh
stress-ng --cpu 0 --cpu-method matrixprod --verify --timeout 5m
for cpu in $(seq 0 15); do
  taskset -c $cpu stress-ng --cpu 1 --cpu-method matrixprod --verify --timeout 30s
done 2>&1 | grep -c 'failed: 0'
python3 ~/workspace-portal/llm-server/acceptance.py
```

**You should see** `passed: 32: cpu (32)` with `failed: 0`, then `16`, then `FUNCTIONAL PASS` and `CAPACITY PASS`.

**Keep it**, once all three passed. This service sets the offset at every boot.

**LLM server**:

```sh
sudo install -m 644 ~/workspace-portal/llm-server/undervolt.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now undervolt.service
sudo journalctl -b -u undervolt.service -o cat | grep coall
```

**You should see**

```text
Successfully set coall to 1048526
```

> **If a check fails or the machine freezes,** reboot: that clears the offset as long as the service is not
> enabled. Then try a smaller offset, for example -30, which is `--set-coall=1048546`, and put the number that
> passed into `/etc/systemd/system/undervolt.service`. To go back to stock, run `sudo systemctl disable
> undervolt.service` and reboot.

## Part 3: Portal server

The small second PC. Steps 11 and 12.

### 11. Workspace Portal

*Portal server · about 10 min*

Installs Docker and [Workspace Portal](https://github.com/ShahriarDhruvo/workspace-portal), points it at the LLM
server, and sizes it for an 8 GB machine: three workspaces of at most 2.25 GiB each. The installer builds the
images, loads the firewall and starts the portal, its own SearXNG for web search, and the page reader that lets
agents open the pages they find. On the 2-core test machine that took 10 minutes.

**Portal server**:

```sh
sudo dnf install -y moby-engine docker-compose docker-buildx nftables git openssl curl
sudo systemctl enable --now docker
git clone https://github.com/ShahriarDhruvo/workspace-portal.git ~/workspace-portal
cd ~/workspace-portal
[ -f .env ] || ( umask 077; cp .env.example .env )
sed -i \
  -e 's|^LLM_UPSTREAM_URL=.*|LLM_UPSTREAM_URL=http://LLM_IP:8080|' \
  -e 's|^LLM_MAX_CONCURRENCY=.*|LLM_MAX_CONCURRENCY=4|' \
  -e 's|^LLM_MAX_CONCURRENCY_PER_USER=.*|LLM_MAX_CONCURRENCY_PER_USER=3|' \
  -e 's|^WORKSPACE_MEMORY=.*|WORKSPACE_MEMORY=2304m|' \
  -e 's|^WORKSPACE_CPUS=.*|WORKSPACE_CPUS=1.5|' \
  -e 's|^MAX_RUNNING_WORKSPACES=.*|MAX_RUNNING_WORKSPACES=3|' .env
curl -s -o /dev/null -w 'model server: %{http_code}\n' http://LLM_IP:8080/ready
sudo bash deploy/install.sh
```

**You should see** `model server: 200` before the build starts, and at the end:

```text
  Workspace Portal is running.

    Portal:     http://PORTAL_IP:3000
    Workspaces: Private ports 3101-3299, Online ports 3301-3499 (one per user and kind)
    Previews:   Private ports 4101-4299, Online ports 4301-4499 (the apps running in them)
    Online:     on (ONLINE_WORKSPACES; Admin > Users switches it off per user)
    Admin:      admin   (first sign-in: grep ^ADMIN_PASSWORD /home/YOUR_LOGIN/workspace-portal/.env; you choose a new one then)
    Agent:      Qwen Code 0.27.0
    Agent:      DeepSeek Harness 0.2.2-rc.1
    Agent:      OpenCode 2.4.1
    Models:     /srv/workspace-portal/config/qwen (deploy/qwen-config.sh; used by every agent)
    Web:        web_search through the built-in SearXNG (http://127.0.0.1:8888); page reader on (read_page)
    Monitoring: this server: portal-hostd on http://127.0.0.1:9180; LLM server: not set up (hostd/README.md)

  Check the workspace isolation at any time:  sudo bash deploy/verify-isolation.sh
```

Checks that the workspaces are sealed, runs one search, and prints the first admin password.

**Portal server**:

```sh
cd ~/workspace-portal
sudo bash deploy/verify-isolation.sh
curl -s 'http://127.0.0.1:8888/search?q=fedora+linux&format=json' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d["results"]), "results, engines that failed:", d["unresponsive_engines"])'
grep ^ADMIN_PASSWORD .env
```

**You should see** one `PASS` line per check and a last line with `failed 0`, after about 9 minutes on the 2-core
test machine: most of that is waiting for connections that must fail. The count before it grows with the setup and
with the workspaces people have used: `passed 389` on the test machine at the end of its tests. Then a line like
`33 results, engines that failed: []`: an engine named in the brackets was turned away this time and comes back by
itself.

Open `http://PORTAL_IP:3000`, sign in as `admin` with that password and choose a new one when asked. Create an
account for each person under **Admin > Users > New user**: the portal shows a temporary password once, and the
person chooses their own at the first sign-in.

Each person has two workspaces with separate files, of which one runs at a time. **Private** has no internet
access. **Online** also reaches public internet addresses, but never your LAN, the servers or another workspace. On
Home, press **Start Private** or **Start Online**, confirm, then **Open workspace**. The agent is Qwen Code unless
the person picks DeepSeek Harness or OpenCode on Home, under Private and Online, or the administrator does on the
person's page under **Admin > Users**; a running workspace keeps its agent until it restarts. With **Plan mode** on,
in the **+** menu under Qwen Code's input, the agent changes nothing and runs no command until its plan is approved.

DeepSeek Harness runs as it ships, with its own workspaces, plugins and permission modes; a workspace leaves out
only signing in to DeepSeek, its own web search (the portal's search replaces it) and opening folders in desktop
apps. A new session starts with **Full access**: the agent changes any file and runs any command in the workspace
without asking. The session's permission menu switches it to **Workspace Write**, **Read Only** or **Auto review**,
where the model judges each action first and asks the person about any it would not allow; **Settings** changes the
default for new sessions. A new session also has **agent teamwork** on: the agent and the subagents it starts divide
large tasks on a shared task board, which spends more tokens; **Enable agent teamwork**, in the menu of the session's
model, switches it off for that session.
Its first workspace is `Documents/deepseek-harness/default-workspace` in the person's home,
apart from Qwen Code's files; **Add workspace** opens any other folder. **Plugins**, in its sidebar, switches on the
plugins DeepSeek Harness comes with and, in an Online workspace, installs others from npm or GitHub. A plugin runs
with the person's own access, so install only those you trust. Its **Browser** shows a web app running in the
workspace, whoever started it: open `http://localhost:PORT`. Its dark theme takes the portal's blacks, as Qwen Code's.

OpenCode (OpenCode 2, the `@opencode/cli` package) also runs as it ships; a workspace leaves out only other model
providers, sharing a session, its own web fetch and search (the portal's search and page reader replace them),
pairing another browser or machine with it, and updating itself. The projects in its sidebar are kept in the
browser, so the first time in a browser choose **Add project**, then **Select folder** in the dialog, which opens
at `/workspace`, where Qwen Code's files are. **New session** starts a session there; any other folder is added as
a project the same way. The sessions are kept in the workspace: the start page lists them by day, for every
project and in any browser, and searches them. Each session opens in a tab, and <kbd>Ctrl</kbd>+<kbd>&#96;</kbd>
opens a terminal beside it. In a turn, a line such as **Used 1 Shell** opens its tool calls and the model's
reasoning. A model's efforts are its variants in OpenCode's model picker.

The agent changes files and runs commands in the workspace without asking. An `opencode.json` in a project's
folder with `{"permissions": [{"action": "shell", "resource": "*", "effect": "ask"}]}` makes it ask before each
command there. OpenCode has no web preview. Its agent looks at an app running in the workspace with the browser
it has; to see the app yourself, open `http://PORTAL_IP:PREVIEW_PORT/__portal/port/PORT/` in a tab of its own.
`PORT` is the port the app listens on. `PREVIEW_PORT` is the person's number plus 4100 for a Private workspace,
plus 4300 for an Online one (the installer's `Previews` line gives the ranges); the number ends the address of
the person's page under **Admin > Users**. Behind HTTPS ([step 12](#12-https-and-remote-access)) the address
starts with `https://NAME.YOUR-TAILNET.ts.net` instead.

#### The API, for your own software

An editor, a script or any other program that speaks the OpenAI API uses the model through the portal. Each person
opens **API** in the portal and presses **Create key**: up to five keys, one for each program. A key is shown once.
The page also gives the two other things a program asks for, the base URL `http://PORTAL_IP:3000/llm/api/v1` and
the model `qwen3.8-flash-next`, and a first request in curl, Python and JavaScript.

**Your PC**:

```sh
curl -s http://PORTAL_IP:3000/llm/api/v1/models -H 'Authorization: Bearer YOUR_API_KEY'
```

**You should see** the model:

```text
{"object":"list","data":[{"id":"qwen3.8-flash-next","object":"model","created":1795049585,"owned_by":"gufo","context_length":262144,"architecture":{"input_modalities":["text","image"]}}]}
```

Everything behind `/llm/api` is Gufo's own API, passed on as it is: Chat Completions, Responses, Anthropic's
Messages and the rest. Software that speaks Anthropic's API takes `http://PORTAL_IP:3000/llm/api` as its base URL.
The page counts for each key and day the requests, the tokens in and out and the energy with its cost, and
**Revoke** stops a key at once.

<details>
<summary>What a key reaches, and what to expect under load</summary>

- **A key reaches the model only:** no workspace, no file and no page of the portal. It works from wherever the
  portal can be opened, so treat it like a password; the portal stores only its hash. A key does not work while its
  account is disabled or still has a temporary password.
- **Sessions are shared:** a request with a key waits for one of the four sessions together with the workspaces,
  and one person's keys and workspace hold at most three at a time (`LLM_MAX_CONCURRENCY_PER_USER`).
- **Waiting is silent:** nothing reaches the program while its request waits for a session and while the model
  reads the prompt. Three 252,000-token requests at once were each answered after 8 minutes, and a fourth from the
  same person started 7.4 minutes late. The OpenAI and Anthropic libraries give up after 10 minutes unless told
  otherwise, so a program with prompts that long needs a longer timeout.
- **Limits:** a request may be 64 MiB. WebSocket connections are not passed on.
- **For the admin:** a request with a key shows under **Admin > Usage** as a busy session and in the reading and
  writing speeds; the table of sessions lists workspaces only.

</details>

#### Live monitoring, energy and Gufo updates

Gives **Admin > Usage** the live readings of both servers, **Admin > Energy** their energy per day and each user's
share of it, and lets **Admin > Updates** [update Gufo](#engine-update). The portal server's half came with the
installer above; this adds the LLM server's.

**LLM server**:

```sh
sudo bash ~/workspace-portal/hostd/install.sh llm --portal PORTAL_IP
```

**You should see**, as the last lines:

```text
install.sh: engine control: gufo.service (quadlet /home/YOUR_LOGIN/.config/containers/systemd/gufo.container, user YOUR_LOGIN)
install.sh: firewalld: zone FedoraServer now lets PORTAL_IP reach tcp/9180
install.sh: portal-hostd (re)started
install.sh: health check passed (role llm, port 9180)

Put these lines in the portal's .env:
HOSTD_LLM_URL=http://LLM_IP:9180
HOSTD_LLM_TOKEN=...
```

The token is 64 characters long. Put it into the next block in place of `PASTE_THE_TOKEN_HERE`.

**Portal server**:

```sh
cd ~/workspace-portal
sed -i \
  -e 's|^HOSTD_LLM_URL=.*|HOSTD_LLM_URL=http://LLM_IP:9180|' \
  -e 's|^HOSTD_LLM_TOKEN=.*|HOSTD_LLM_TOKEN=PASTE_THE_TOKEN_HERE|' .env
sudo docker compose up -d
```

**You should see** both servers under Admin > Usage, with power, CPU, GPU, memory, disk and network changing twice
a second.

<details>
<summary>Energy prices, who can reach the monitoring, and how to remove it</summary>

- **Energy** is counted per day, from the install on, in the server's time zone (the installer writes it to `.env`
  as `TZ`). For the money, pick where you live under **Settings > Electricity price**: a US state uses the EIA's
  monthly average residential price, a European country Eurostat's half-yearly household price with taxes. The
  portal downloads both every day, no account needed. The kWh come from the chips' own sensors, so a wall meter
  reads more.
- **Access:** `portal-hostd`, the daemon that takes the readings, listens on 127.0.0.1 only on the portal server.
  On the LLM server it listens on port 9180, and its installer adds one firewall rule that lets only the portal
  server in. Every request except the health check needs the token; workspaces cannot reach either server. What it
  costs to run: [MEASUREMENTS.md](MEASUREMENTS.md#portal-hostd).
- **Removal:** `sudo bash ~/workspace-portal/hostd/install.sh uninstall` on a server removes the daemon and its
  firewall rule. Gufo stays as it is.

</details>

<details>
<summary>Cap the disk space of the workspaces</summary>

Everyone's files share the disk with the system, so one person can fill it for all. On an XFS root, Fedora Server's
default, a project quota caps the workspaces together. Pick a size that leaves room for the system and the images:
here 150 GB of 237.

**Portal server**:

```sh
sudo grubby --update-kernel=ALL --args=rootflags=prjquota
sudo reboot
```

**Portal server**, after the reboot:

```sh
sudo xfs_quota -x -c 'project -s -p /srv/workspace-portal/users 1000' -c 'limit -p bhard=150g 1000' /
sudo xfs_quota -x -c 'report -p -h' /
```

**You should see** project `#1000` with `150G` in the Hard column. A workspace then sees a 150 GB disk, a write
beyond the cap ends with `No space left on device`, and the system keeps its room. Any project number but 1 will
do: Docker clears the limit of project 1 each time it starts.

</details>

<a id="settings"></a>

<details>
<summary>The settings, and how to apply a change</summary>

|  |  |
|---|---|
| `WORKSPACE_MEMORY=2304m`<br>`MAX_RUNNING_WORKSPACES=3` | Sized for 8 GB, of which the portal leaves about 6.3 GB: less than three full workspaces, which ordinary work does not come near (three agents at 2 GiB finished with 2.8 GB to spare). If all three do fill up at once, the kernel kills a process in one of them; set 2 where that must not happen. With more RAM raise the number of workspaces and count about 2.75 GiB for each ([measurements](MEASUREMENTS.md#workspace-memory)). When all are busy, the next person is told that all slots are busy; a workspace that has been idle for more than five minutes gives up its slot instead. |
| `WORKSPACE_CPUS=1.5` | Sized for a 2-core machine. Raise it on a bigger one. |
| `LLM_MAX_CONCURRENCY=4` | Matches the four sessions. More requests wait in the portal instead of in Gufo. |
| `LLM_MAX_CONCURRENCY_PER_USER=3` | One person with many subagents cannot take every session. |
| `DEFAULT_REASONING_EFFORT=low` | The default. Every new agent session starts at low effort, which answers faster; raise it inside a session for a hard task. `medium` and `xhigh` are this model's other two efforts. |
| `system-defaults.json` | Not in `.env`: Qwen Code's defaults, in `/srv/workspace-portal/config/qwen`, with the model and its context of 262,144 tokens. It names no `max_tokens`, so Qwen Code asks for replies of 64,000 tokens and continues one that was cut off, and it sets `autoCompactThreshold` to 0.7, so Qwen Code compacts a conversation at 183,500 tokens and a whole reply always fits behind it. `sudo bash deploy/qwen-config.sh show` prints it and `install` replaces it; workspaces read it at their next start. |
| `ONLINE_WORKSPACES=on` | The default. An Online workspace reaches public addresses over TCP on any port and looks up names only at 1.1.1.1 and 9.9.9.9; the firewall drops your LAN, both servers and every other container. `off` removes Online for everyone; a person's page under **Admin > Users** switches it off for one person. |
| `READER_URL_POLICY=shown` | The default. An agent opens only pages it was shown: search results, links on pages it has read and addresses in the conversation, plus a built-in list of documentation and code sites. The page is requested exactly as it was shown, which stops a poisoned page from making the agent send your files to an address it puts together itself. It is a filter, not a guarantee. `any` opens every public page; `READER_URL=off` removes the page reader. |

`.env.example` lists every setting with its default. A change in `.env` takes effect with `sudo docker compose up
-d`; workspaces pick up new limits the next time they start. Run `sudo bash deploy/install.sh` instead after
changing `PORTAL_DATA_DIR`, `HOSTD_PORTAL_*`, `FIREWALL_*`, `WORKSPACE_AGENTS`, an agent's `*_VERSION`, a port,
subnet, `*_GATEWAY_IP`, bridge, DNS server or the server in a `*_URL`: the firewall, portal-hostd and the images
are made from them.

</details>

<details>
<summary>Web search and the page reader</summary>

- **Search** needs no setup: SearXNG is one of the portal's containers, without an account or API key, and only the
  portal can reach it. Keenable, Yahoo, Yandex and MetaCrawler are always asked; Keenable allows 1,000 searches an
  hour from one address without a key. DuckDuckGo, Swisscows, PrivacyWall and Mojeek are asked only when a search
  finds fewer than three results.
- **An engine that turns you away** sits out and the others carry on: 10 minutes after "access denied", 30 after
  "too many requests", 60 after a CAPTCHA. The agent is told which engines did not answer. Do not load-test the
  search: about one query a second got the test address blocked by two engines for over an hour.
- **Other engines:** edit `searxng/settings.yml` in `~/workspace-portal`, keep `SEARCH_FALLBACK_ENGINES` in `.env`
  in step with the engines it marks `disabled: true`, and run the installer again. Engines that were tried and left
  out: [MEASUREMENTS.md](MEASUREMENTS.md#web-search).
- **Exa first:** [Exa](https://exa.ai) is a search service made for AI agents. With `EXA_SEARCH=on` in `.env` it
  answers a search before SearXNG does, without an account or a key. It is off unless you turn it on, because each
  such search leaves your server for a company. Exa answers the first page of a plain search; a later page, a time
  range or a language goes to SearXNG, and so does every search for ten minutes after Exa refused one or failed. Exa
  does not say how many searches it takes without a key, and everyone on the portal shares that number, as they
  share the server's address. The agents see one search tool either way.
- **The page reader** returns the main text of a page or a PDF as markdown, 20,000 characters per call. There is no
  browser inside: pages that need JavaScript and sites that turn automated readers away cannot be read.
- **What leaves your network:** a page read is one request to that site, a search sends the query to the search
  engines, and both look names up at 1.1.1.1 and 9.9.9.9. With `EXA_SEARCH=on` a search goes to `mcp.exa.ai`
  first, from the gateway and with nothing but the query. When it starts, SearXNG also downloads a public list of
  tracking parameters (ClearURLs) that it strips from result links. Other resolvers: `READER_DNS_1`,
  `READER_DNS_2`, `SEARXNG_DNS_1` and `SEARXNG_DNS_2`, then the installer again. Both containers connect only to
  public addresses on ports 80 and 443, which the isolation check above tests.

</details>

### 12. HTTPS and remote access

*Portal server · optional*

Puts the portal server on your [Tailscale](https://tailscale.com/) network and serves the portal there over HTTPS,
at home and away. From then on only devices signed in to your tailnet reach it, and a phone can install it as an
app.

**Portal server**:

```sh
sudo dnf install -y tailscale
sudo systemctl enable --now tailscaled
sudo tailscale up
```

`tailscale up` prints a sign-in link. Then, in the [Tailscale admin
console](https://login.tailscale.com/admin/dns), enable **MagicDNS** and **HTTPS Certificates** under DNS, and
switch off key expiry for this machine under Machines, or it drops out after 180 days.

**Portal server**:

```sh
cd ~/workspace-portal && sudo bash deploy/tailscale-https.sh
```

**You should see**, after about half a minute, the portal's new address as the last line:

```text
Portal: https://NAME.YOUR-TAILNET.ts.net
```

Open it on any device signed in to the same tailnet. The first page takes half a minute, while Tailscale fetches
the certificate. To install the portal as an app, use **Add to Home screen** in Chrome's menu on Android, or
**Share > Add to Home Screen** in Safari on an iPhone.

The [API](#the-api-for-your-own-software)'s base URL is then `https://NAME.YOUR-TAILNET.ts.net/llm/api/v1`, as the
API page shows once it is opened at the new address, and a program reaches it only from a device signed in to the
tailnet.

> The portal now listens behind Tailscale only: `http://PORTAL_IP:3000` no longer answers, and `sudo bash
> deploy/tailscale-https.sh off` brings it back. Run it with `off` before you change one of the portal's ports or
> uninstall the portal, and again after a port change. Every device of the tailnet also reaches this machine's SSH,
> which takes keys only. The machine's name becomes public, because every certificate is listed in the public
> certificate logs. The LLM server needs no remote access of its own: keep it on the LAN.

## Day to day

Both servers start everything by themselves at boot. **Admin > Usage** in the portal shows both servers and the LLM
sessions live, and **Admin > Users** the running workspaces; these are the commands for everything else.

| LLM server | What it does |
|---|---|
| `systemctl --user status gufo.service --no-pager` | State and uptime of the model. |
| `journalctl --user -u gufo.service -f` | Live log. |
| `curl -s http://127.0.0.1:8080/slots \| jq -c '[.[] \| .is_processing]'` | Which of the four sessions are busy. |
| `systemctl --user restart gufo.service` | Restart. Requests in progress are lost. |
| `grep . /sys/class/ec_su_axb35/apu/power_mode /sys/class/ec_su_axb35/temp1/temp /sys/class/ec_su_axb35/fan[12]/{rpm,duty}` | Power profile, controller temperature, fan speeds and duty. |
| `btop` `nvtop` | CPU, RAM and swap. GPU load and memory. |
| `systemctl status portal-hostd --no-pager` | portal-hostd, which feeds **Admin > Usage** and **Energy** and carries out Gufo updates. |

| Portal server in `~/workspace-portal` | What it does |
|---|---|
| `sudo docker compose ps` | State of the portal. |
| `sudo docker compose logs -f gateway web reader` | Live log. Every search and page read is a line of the gateway's. |
| `sudo docker compose logs searxng 2>&1 \| grep -E 'ERROR\|WARNING' \| grep -v botdetection \| tail -20` | What went wrong in the search engine: which engine failed, and why. |
| `sudo docker ps --filter label=workspace-portal.workspace=1 --format '{{.Names}} {{.Label "workspace-portal.agent"}} {{.Status}}'` | Running workspaces and their agents. |
| `sudo docker compose up -d` | Applies a change made in `.env`. Some settings need the installer instead: see [step 11](#settings). |
| `sudo bash deploy/verify-isolation.sh` | Tests the sandboxes, the search engine and the page reader again. Must end with `failed 0`. |
| `systemctl status workspace-portal-firewall --no-pager` | The firewall around the workspaces, the search engine and the page reader. Docker starts only once it is loaded. |
| `sudo systemctl reload workspace-portal-firewall` | Loads its rules again. Reload, never restart: a restart stops Docker and every workspace with it. |
| `sudo bash deploy/uninstall.sh` | Removes the portal: its containers, images, firewall and portal-hostd. Keeps `.env` and `/srv/workspace-portal`; with `--purge-data` it deletes that folder too. |

<details>
<summary>After a reboot of the LLM server</summary>

**LLM server**:

```sh
systemctl --failed --no-legend; systemctl --user --failed --no-legend
podman ps --format '{{.Names}} {{.Status}}'
systemctl is-active m5-fans portal-hostd
cat /sys/class/ec_su_axb35/apu/power_mode
sudo firewall-cmd --zone=FedoraServer --list-rich-rules
sudo journalctl -b -u undervolt.service -o cat | grep coall
```

**Good:** no failed units, `gufo Up ... (healthy)`, two services `active`, `performance`, two firewall rules naming
the portal server, for ports 8080 and 9180, and, with the undervolt of [step 10](#10-cpu-undervolt), `Successfully
set coall to 1048526`.

</details>

<a id="engine-update"></a>

<details>
<summary>Updating the LLM server</summary>

**After a kernel update**, `dkms status` must list `ec_su_axb35/m5-1` as installed for the new kernel, and the
speed check from [step 9](#9-test-it) should still show the same numbers. If the new kernel misbehaves, boot the
previous one:

**LLM server**:

```sh
sudo grubby --info=ALL | grep -E '^(index|title)'
sudo grubby --set-default-index=1        # the index of the kernel that worked
sudo reboot
```

**A new Gufo release** is installed under **Admin > Updates > LLM engine** in the portal, which lists the releases
with their notes and marks breaking changes. The new image downloads, running requests finish while new ones wait
in the portal (up to 15 minutes, or **Restart now**), then Gufo restarts and must report the new version. If it
does not come up, the previous version is put back by itself, and the failed update ends with Gufo's own last log
lines: why it did not start. To go back to an older version later, pick it under **Package images**. By hand:
replace the image digest in `~/.config/containers/systemd/gufo.container`, then `systemctl --user daemon-reload` and
`systemctl --user restart gufo.service`.

</details>

<details>
<summary>Backups</summary>

The model can be downloaded again. What cannot, on the portal server: `~/workspace-portal/.env` and
`/srv/workspace-portal`, where `db/` holds the accounts, the API keys, the audit log, usage and energy, `users/`
every person's files and chat history, and `config/` the model settings and the agent versions. Copy it with
numeric owners and modes, because each workspace's files belong to a user ID of their own, and stop the portal
while `db/` is copied: `sudo docker compose down`, afterwards `sudo docker compose up -d`. On the LLM server only
`~/.config/containers/systemd/gufo.container`.

</details>

## Update the portal

The portal, its search engine, the page reader and the firewall all come from one repository, so one update brings
all of them. Do it when no agent is working: the gateway restarts, and an answer the model is writing at that
moment is cut off.

**Portal server**:

```sh
cd ~/workspace-portal
git pull --ff-only
sudo bash deploy/install.sh
sudo bash deploy/verify-isolation.sh
```

**You should see** `Workspace Portal is running.` within 2 minutes, and `failed 0` about 9 minutes later. Running
workspaces keep running, and an open browser tab carries on without a reload.

<details>
<summary>What it keeps, and what it does not update</summary>

- **Kept:** `.env`, the model settings, the accounts, every person's files and chat history. The installer adds the
  settings your `.env` lacks and changes none. It refuses to run while an update from **Admin > Updates** is in
  progress.
- **Running workspaces** keep the image they started with and get the new one at their next start.
- **The agents** stay at their versions. **Admin > Updates** shows the current and the latest release of each
  enabled agent and updates it with one button. An update fails, and the current version stays, when the portal's
  changes do not fit the new version or it does not pass the portal's check; the failed update names what did not
  fit. From the shell: `sudo bash deploy/update-image.sh qwen VERSION`, with `dsh` for DeepSeek Harness and
  `opencode` for OpenCode.
- **A new agent** (OpenCode, for an install from before it) stays off, because the installer keeps
  `WORKSPACE_AGENTS` in your `.env`: add `opencode` to it, as in `WORKSPACE_AGENTS=qwen,dsh,opencode`, and run the
  installer again. It builds the agent's image, about 2 GB.
- **portal-hostd on the LLM server** updates separately: `cd ~/workspace-portal && git pull --ff-only && sudo bash
  hostd/install.sh llm --portal PORTAL_IP` there. It keeps its token and restarts only if something changed.
- **Chromium and the other system packages** inside the workspace images: `sudo bash deploy/update-image.sh
  --refresh` rebuilds the images with today's packages.
- **Going back:** `git log --oneline` lists the versions. `git checkout COMMIT` and the installer again bring that
  one back; `git checkout main` returns to the newest.
- **Your own changes** to a file of the repository, such as `searxng/settings.yml`: `git stash` before the pull and
  `git stash pop` after it.

</details>

## When something is off

| You see | Cause and fix |
|---|---|
| Linux shows only about 62 GB | UMA is still at 64 GB. Redo the first command of [step 5](#5-unlock-the-memory) and reboot. |
| GTT total is about half the RAM | The kernel options are not active. Check `cat /proc/cmdline`; they apply after a reboot. |
| `gufo.service` stays `activating` | It loads the model and waits for the first health check: 17 to 18 seconds on the test machine. |
| Gufo is restarted while loading | Loading took over 10 minutes, usually a slow disk. Raise `TimeoutStartSec` in `gufo.container`. |
| The model disappears under load | Read `journalctl --user -u gufo.service` and `sudo journalctl -k -b`. Exit status 75 is the stall timeout: nothing progressed for 10 minutes. An out-of-memory kill means something else is running on the LLM server, or the layout is too big. |
| HTTP 429 from the model | More than 32 requests are waiting. Let the queue drain. |
| An agent thinks for minutes and stops without an answer | The reply ran out during the thinking. `gufo.container` must have its `--reasoning-budget` ([step 8](#8-start-the-model)), and `sudo bash deploy/qwen-config.sh show` must list an `autoCompactThreshold` and no `max_tokens`. |
| An agent never gets an answer | All four sessions are busy with long prompts, and a long prompt slows everyone who arrives after it. Look at `/slots` (see [Day to day](#day-to-day)). |
| The load test in step 9 says `FAIL` | A failed session says why on its own line; the line of readings shows whether all sessions ran at once, how much memory was left, and whether anything was swapped or killed. |
| The installer in step 7 says `refusing` or `Secure Boot is not off` | The first names what differs from the tested board and BIOS (AXB35-02, 3.11): the check is deliberate, stay on the firmware's fan control. For the second, switch Secure Boot off in the BIOS ([step 1](#1-install-fedora-server)) and run the installer again. |
| `/sys/class/ec_su_axb35` is missing | The driver is not loaded, usually because DKMS has not built it for a new kernel. `dkms status ec_su_axb35` must say `installed` for the running kernel; `sudo dkms autoinstall` builds it, and the fan service loads it within 10 seconds. |
| The installer in step 11 ends with `the stack did not become healthy` | One of the four containers did not come up. `sudo docker compose ps` names it and `sudo docker compose logs NAME` says why. Run the installer again afterwards. |
| Portal chat: `404 model ... is not served` | The model name in `system-defaults.json` must be `qwen3.8-flash-next`, the name Gufo serves. |
| An agent dies on its first tool call | `WORKSPACE_MEMORY` is too small. Qwen Code needs about 1.9 GB for a moment; use 2 GiB or more. |
| The Web preview (DeepSeek Harness: Browser) stays blank | Type the app's own address, such as `http://localhost:3000`: the portal opens that port of the workspace. The app's server must listen on all addresses (`0.0.0.0`; Vite needs `--host`). In a Private workspace the preview loads nothing from other sites, so an app that takes scripts or fonts from a CDN stays incomplete there. Sites that forbid framing, Google among them, stay blank in any preview: use **Open externally**. OpenCode has no preview: the app opens in a tab of its own ([step 11](#11-workspace-portal)), and what this row says of the app's server holds there too. |
| Agents report no search results | The answer names the engines that did not answer. They sit out for 10 to 60 minutes and come back by themselves. |
| `read_page only opens pages you were shown` | The agent took the address from memory or made it up. Have it search first, paste the address into the chat, or change `READER_URL_POLICY` ([step 11](#settings)). |
| `read_page`: `The site refused the request` | That site turns automated readers away. The agent has to use another source. |
| `read_page`: `The page reader is busy` | It reads two pages at a time and the rest wait up to 30 seconds. The agent can ask again. |
| The portal cannot reach the model | From the portal server, `curl http://LLM_IP:8080/ready` must answer. If not, the firewall rule in [step 8](#8-start-the-model) names the wrong address. |
| A program on the API gets `401` with `Incorrect API key` | The key was mistyped or revoked, or its account is disabled or still has a temporary password. The API page lists the working keys with their last four characters; create a new one there. |
| A program on the API gives up before an answer comes | Its request was waiting for a session, or the model was still reading a long prompt: nothing is sent in that time. **Admin > Usage** shows the busy sessions; give the program a longer timeout ([step 11](#the-api-for-your-own-software)). |
| The portal's HTTPS address does not open | The device is not signed in to the tailnet, or Tailscale is down on the portal server: `tailscale status` there. `sudo tailscale serve status \| head` must list the portal's ports; `sudo bash deploy/tailscale-https.sh` writes them again. |
| The portal does not come up after a reboot | Docker waits for the workspace firewall and stays down if it fails to load. `systemctl status workspace-portal-firewall --no-pager` says why; `sudo bash deploy/install.sh` writes it again. |
| Online cannot be picked | The card says why. **Online workspaces are turned off on this portal**: `.env` says `ONLINE_WORKSPACES=off`, or the workspace firewall is not loaded (see the row above). **Online workspaces aren't enabled for this account**: the switch on that person's page under **Admin > Users** is off. |
| The admin password is lost | `sudo docker compose exec web node scripts/reset-admin-password.mjs` in `~/workspace-portal` prints a temporary password and signs the admin out everywhere. |

## Numbers to expect

Measured on one unit, at room temperature, with the settings from this guide. If yours is slower, check that the
fan service is running and that the vents have space on all sides. How each was measured, and what else was tried:
[MEASUREMENTS.md](MEASUREMENTS.md).

| What | Result | Conditions |
|---|---|---|
| Writing, one user | **51-79 tok/s** | 99 answers, half of them at 62 to 67. Varies with how many drafted tokens are accepted |
| Writing, four users at once | **about 20 tok/s each**, 70 in total | 8,000-token prompts; measured with a four-session layout on Gufo 0.28.1 |
| Writing, six and eight users on those four sessions | 20 and 18 tok/s each | The extra users wait for a free session: up to 90 s and 114 s to the first word |
| Reading a prompt | **1,760-1,787 tok/s** | 32,000-token prompts, machine hot, fans at 80-95% |
| A 90,000-token prompt | about 55 s to the first word | One user |
| Four 256,000-token prompts at once | 10.6-10.7 min to the first word | The full-load test of step 9. Follow-up turns: 0.7-1.0 s |
| A turn in a long agent session | 0.6 s to the first word, 53 tok/s | Median of 278 agent requests; history served from cache |
| A new 122,000-token prompt on a full machine | 9-17 min to the first word | Measured with seven 128K sessions, all of them already reading 122,000-token prompts |
| Model load / restart | 16-17 s / healthy after 17-18 s | Four restarts. The load after a reboot took 17.4 s |
| After a reboot | Gufo answers after 32 s, the portal after 22 s | Counted from the start of the kernel; nothing to start by hand on either server |
| Raw photo, whole answer | 147 s (12 MP), 353 s (16.8 MP) | Idle server, image sent to the API at full size. Qwen Code shrinks images to 1,568 pixels on the long edge first, which is quick |
| Chip power | 121-128 W under load, about 7 W idle | The chip's own sensor, not a wall meter |
| Chip temperature under load | 83-89 °C average | Fans at 80-95%; 86-94 °C on firmware fans. At its limit, 98-101 °C, for the first three minutes of the full-load test |
| Free memory, LLM server | 9.6 GiB after load, 6.5 GiB with four full prompts at once | 4.7 GiB while four raw 12 MP photos were read. The full-load run moved 1 page to swap, the other tests none |
| Cancelling a reply | session free 0.5 s later | Three clients dropped mid-reply. With three sessions busy, a fourth request waited 5 s for its first word |

## Not tested

- A fresh install from USB and the BIOS screens. Both test machines kept their installed Fedora, so [step
  1](#1-install-fedora-server) was not run on them: its LVM commands for the LLM server ran on a test disk image,
  the portal server's line not at all.
- [Step 6](#6-download-the-model) from an empty folder. Its blocks ran as written in a scratch folder that already
  held the three model files, the MTP helper and the vision file, so the download fetched the n-gram table and the
  script and only checked those five. The files were then moved into place.
- Most numbers with the 8.5-bit n-gram table. The full-load test and 20 of the 99 writing speeds are from it; the
  others were taken with Unsloth's 4.5-bit table or the full-precision one, which side by side read and write
  within 2% of it ([measurements](MEASUREMENTS.md#n-gram-table)).
- The older numbers on the current kernel. The reading speeds on the fan curve, the image timings and the
  full-machine run date from kernel 7.2.15 and were not repeated with 7.3.4.
- Fedora 45 on the LLM server, and a Fedora release upgrade on either server.
- Coming back after a real power cut.
- A Gufo update that fails to start, and **Restart now**, in the last test. An earlier forced bad update put the
  previous version back by itself.
- More than the 9 hours of continuous load tests the model has served without a restart.
- DeepSeek Harness under load. The stress runs used Qwen Code.
- OpenCode on these servers, and OpenCode with the real model. Its image was built on a development machine and
  run there as a workspace runs, behind the portal's gateway and in a browser, with a stand-in for the model. So
  the times of [step 11](#11-workspace-portal) and of the isolation check are without its image, and nothing here
  says how it handles a long conversation or an answer cut off at the model's limit, or what memory it needs.
- The page reader under many agents at once. It was tested with one agent of each kind and with six pages at a
  time.
- [Step 12](#12-https-and-remote-access) from its first line. Tailscale was already installed and signed in, so
  only `tailscale-https.sh` ran, on and off. Over HTTPS the portal, both kinds of workspace, Qwen Code, DeepSeek
  Harness and a web preview were then used from a PC of the same tailnet, on the server's LAN and from another
  network.
- The [API](#the-api-for-your-own-software) at the portal's LAN address, and an editor on it. The test portal
  answers over HTTPS only ([step 12](#12-https-and-remote-access)). There curl, the OpenAI libraries for Python
  (3.55.1) and Node (7.60.0) and Anthropic's for Python (2.10.0) used it with a key, and 56 of 61 different
  requests got the same answer as from Gufo itself; the other five differ in a redirect for a trailing slash, a
  timestamp, the case of header names and a WebSocket request, which is closed.
- Installing the portal as an app on a real phone, and a screen reader. Chrome's own install check passed with an
  emulated Pixel 7; no iPhone was at hand.
- A kernel update on the LLM server with this fan driver. DKMS has built it for the running kernel only.
- Fan noise and power at the wall. No meters were at hand.
- The undervolt of [step 10](#10-cpu-undervolt) for longer than a day, and a kernel update with it. After a reboot
  its service set the offset again. Without RyzenAdj's kernel driver, which a new kernel needs built again, it was
  started by hand only.

## Versions and sources

| Part | Version on the test machines |
|---|---|
| LLM server | Ryzen AI Max+ 395, 128 GB, board AXB35-02, BIOS 3.11 (May 8, 2026); Fedora 44 Server, kernel 7.3.4-200.fc44, Mesa 26.2.6, Podman 5.8.9, crun 1.30 |
| Engine | [Gufo 0.35.0](https://github.com/gufo-org/gufo/releases/tag/v0.35.0) (build 0260e11), image digest `sha256:99e9b547...f9e9c2b6` |
| Model | [Qwen3.8-Flash-Next](https://huggingface.co/Qwen/Qwen3.8-Flash-Next), [UD-Q4_K_XL from Unsloth](https://huggingface.co/unsloth/Qwen3.8-Flash-Next-GGUF/tree/f5d175de2cf7f720d45d6064019a81fcf056e986) with the Q8_0 n-gram table, shared Q8 MTP, BF16 vision projector; downloaded with huggingface_hub 2.4.0 and hf-xet 1.8.0 |
| Fan driver | `llm-server/fans/ec_su_axb35.c` in the repository, version m5-1: reduced from [cmetz/ec-su_axb35-linux](https://github.com/cmetz/ec-su_axb35-linux/tree/f62c2c228959a08683273a26ef3afd8991e69f6d) at f62c2c2, duty registers after [FanControl.AXB35](https://github.com/crmaris/FanControl.AXB35) |
| CPU undervolt | [RyzenAdj](https://github.com/FlyGoat/RyzenAdj) 0.18.0 (527cacc) from [COPR shdwchn10/ryzenadj](https://copr.fedorainfracloud.org/coprs/shdwchn10/ryzenadj/), with its `ryzen_smu` driver (d298366) |
| Portal server | Pentium G4400T (2 cores), 8 GB; Fedora 45 Server, kernel 7.3.4-300.fc45, moby-engine 29.9.3, Tailscale 1.102.5 |
| Portal | [Workspace Portal](https://github.com/ShahriarDhruvo/workspace-portal), [Qwen Code](https://github.com/QwenLM/qwen-code) 0.28.0 (a fresh install builds 0.27.0; updated under **Admin > Updates**), DeepSeek Harness 0.2.2-rc.1, [SearXNG](https://github.com/searxng/searxng) 2026.11.12. Page reader: [Defuddle](https://github.com/kepano/defuddle) 0.19.6, pypdfium2 5.15.2 |

Further reading: [Gufo server options](https://github.com/gufo-org/gufo/blob/v0.35.0/docs/server.md) · [amdgpu
kernel parameters](https://docs.kernel.org/gpu/amdgpu/module-parameters.html) · [kyuz0's Strix Halo
toolboxes](https://github.com/kyuz0/amd-strix-halo-toolboxes) · [strixhalo.wiki](https://strixhalo.wiki/) ·
[Hardware Busters on the test machine's fans](https://hwbusters.com/?p=116224) · [Tailscale on
Linux](https://tailscale.com/docs/install/linux)

*Strix Halo local agent server, November 20, 2026. Results come from one unit and will differ a little on yours.*
