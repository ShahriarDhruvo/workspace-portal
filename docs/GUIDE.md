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
| **Portal server** | Workspace Portal: sandboxed Qwen Code, DeepSeek Harness and OpenCode workspaces for each person, a Private and an Online one per agent, with SearXNG search and a page reader, plus the model's API behind each person's own keys | from the browser, on port 3000 or 443 |
| **AI server** | The Strix Halo machine: Gufo serving Qwen3.8-Flash-Next with vision | from the portal server only, on port 8080 |

<details>
<summary>No second machine?</summary>

**API only.** Skip part 3 and use the model from your own PC through an SSH tunnel. Any OpenAI-compatible client
then talks to `http://127.0.0.1:8080/v1`.

**Your PC**:

```sh
ssh -N -T -o ExitOnForwardFailure=yes -L 127.0.0.1:8080:127.0.0.1:8080 YOUR_LOGIN@LLM_IP
```

**Agents on the AI server itself** are not set up in this guide. Use the 3 × 256K layout from [step 8](#layouts);
it was not tried with busy sandboxes next to the model. Free memory in each layout:
[MEASUREMENTS.md](MEASUREMENTS.md#memory).

</details>

## Before you start

- **The AI server:** a Strix Halo machine (Ryzen AI Max+ 395) with 128 GB. [Step 7](#7-fans-power-and-watchdog),
  fans, power and watchdog, runs on the tested board and BIOS only.
- **A second PC** for part 3: any x86-64 machine with 8 GB of RAM.
- **A USB stick** with [Fedora Server](https://fedoraproject.org/server/download/) for both machines, and your own
  PC with SSH. The AI server was measured on [Fedora
  44](https://dl.fedoraproject.org/pub/fedora/linux/releases/44/Server/x86_64/iso/); the portal server runs 45.
- **Time:** about an hour of typing, plus a 141 GB download (62 minutes at 38 MB/s).

The commands use three placeholders. Put your own values in their place: `LLM_IP` and `PORTAL_IP`, the addresses of
the two servers, and `YOUR_LOGIN`, your login on both.

The line above each command block says where to run it: **Both servers**, **AI server**, **Portal server** or
**Your PC**.

## Part 1: Both servers

A fresh Fedora Server on each machine. Steps 1 to 3.

### 1. Install Fedora Server

*At each machine · about 30 min each*

1. **BIOS, AI server only.** Tap <kbd>Del</kbd> at power-on. Set **Security > Secure Boot** to Disabled, because
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

**AI server:** grow the root to 200 GB and put the rest of the disk into `/models`, where the 141 GB of model
files go:

**AI server**, only for a small LVM root:

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
8](#8-start-the-models) says `FedoraServer`. The rules for the model and the portal come with steps 8 and 10.

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
disk. Four kernel lines on the AI server are not hardware errors: `virt/tdx: TDX not supported by the host
platform`, and three from `amdxdna`, the driver of the NPU, which is not used here and cannot start once step 5 has
turned the IOMMU off (`Running without IOMMU not supported`, `Hardware init failed, ret -22`, `probe ... failed
with error -22`). The portal test machine, an old PC without a TPM, prints the TDX line too, and `DMAR: [Firmware
Bug]`, `SGX disabled or unsupported by BIOS` and `ima: Error Communicating to TPM chip`: features it lacks, not
faults.

The AI server has its own checks [after a reboot](#day-to-day) and [after a kernel update](#engine-update). The
portal comes back by itself and is updated [separately](#update-the-portal).

<details>
<summary>Automatic updates, and a new Fedora release</summary>

Fedora can install updates by itself ([dnf
automatic](https://docs.fedoraproject.org/en-US/quick-docs/autoupdates/)). It is switched off on both test
machines, because an update can restart Docker, which stops every workspace.

A new Fedora release comes out every six months and gets updates for about thirteen. The upgrade is a download and
one long reboot, described in Fedora's [upgrade
guide](https://docs.fedoraproject.org/en-US/quick-docs/upgrading-fedora-offline/). On the AI server, run the speed
check from [step 9](#9-test-it) again afterwards.

</details>

## Part 2: AI server

The Strix Halo machine. Steps 4 to 9, and the optional [media models](#media-models) after step 8.

### 4. Tools and CPU profile

*AI server*

Installs Podman and the monitoring tools, lets containers use the GPU under SELinux, sets the CPU governor to
performance, lets your services start at boot without a login, creates `/models`, and fetches the
[repository](https://github.com/ShahriarDhruvo/workspace-portal) whose `llm-server` folder the next steps run.

**AI server**:

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

**AI server**:

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

*AI server · 1 reboot*

**UMA.** The test machine ships with 64 GB fixed to the GPU, so Linux sees only about 62 GB. This shrinks the fixed
part to its 512 MB minimum. The GPU borrows what it needs instead.

**AI server**:

```sh
cat /sys/class/drm/card*/device/uma/carveout_options
echo 0 | sudo tee /sys/class/drm/card*/device/uma/carveout
```

> On BIOS 3.11 the list starts with `0: Minimum (512 MB)`. If your list differs, write the number that stands next
> to Minimum.

**GTT limit and IOMMU.** Lets the GPU borrow up to 124 GiB of RAM and turns the IOMMU off. Then reboot.

**AI server**:

```sh
sudo grubby --update-kernel=ALL --args="amd_iommu=off ttm.pages_limit=32505856"
sudo reboot
```

**AI server**, after the reboot:

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

**AI server**:

```sh
sudo grubby --update-kernel=ALL --remove-args=amd_iommu=off
sudo reboot
```

</details>

### 6. Download the model

*AI server · about 65 minutes, unattended*

Opens a terminal session that keeps running if your connection drops.

**AI server**:

```sh
tmux new-session -A -s setup
```

Installs the [Hugging Face CLI](https://huggingface.co/docs/huggingface_hub/guides/cli) into its own Python
environment in your home folder.

**AI server**, inside tmux:

```sh
python3 -m venv ~/.hf-cli && ~/.hf-cli/bin/pip install --quiet huggingface_hub
```

Fetches Qwen3.8-Flash-Next (Q4) with its n-gram table at 8.5 bits a value, its MTP helper and the vision file from
one fixed revision of Unsloth's repository: seven files, 141 GB. The last line checks each file against the SHA256
the Hub lists for it.

**AI server**, inside tmux:

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

**AI server**, once the check has passed:

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

### 7. Fans, power and watchdog

*AI server · tested board only*

Builds the driver for the board's controller chip with DKMS and starts one service. It holds a fan curve that
follows the hotter of CPU and GPU, both main fans at their top speed from 70 °C, and selects the firmware's
Performance profile (120 W sustained, 160 W peak) whenever it starts. The installer refuses any board or BIOS but the tested one, and a machine with Secure
Boot on; the firmware then keeps the fans.

**AI server**:

```sh
sudo bash ~/workspace-portal/llm-server/fans/install.sh
```

**You should see**, as the last line:

```text
install.sh: module m5-2, profile performance, fan curve running
```

**AI server**, check:

```sh
systemctl is-active m5-fans.service
dkms status ec_su_axb35
grep . /sys/class/ec_su_axb35/apu/power_mode /sys/class/ec_su_axb35/fan[12]/rpm /sys/class/ec_su_axb35/fan[12]/duty
```

**You should see**, with your kernel in the second line:

```text
active
ec_su_axb35/m5-2, 7.3.4-200.fc44.x86_64, x86_64: installed
/sys/class/ec_su_axb35/apu/power_mode:performance
/sys/class/ec_su_axb35/fan1/rpm:0
/sys/class/ec_su_axb35/fan2/rpm:0
/sys/class/ec_su_axb35/fan1/duty:0
/sys/class/ec_su_axb35/fan2/duty:0
```

> Duty `0` means the firmware has the fans, which is the case below 60 °C; while the chip is cool they may stand
> still. Under load they get clearly louder than stock. The curve is listed in
> [llm-server/README.md](../llm-server/README.md), what it gains in [MEASUREMENTS.md](MEASUREMENTS.md#fans).

Then raise the chip's limits to the most the firmware allows, give every CPU core a curve offset of -25, and turn
on the watchdog. Asked for 180 W and 100 °C, the firmware keeps 132 W sustained, 140 W for minutes, 160 W in
bursts and 98 °C. The offset gives 3.7% more CPU work at the same power; prompt reading gains about 1% at most,
as the GPU does that work. -50, the deepest that does anything, gives 8% but froze the test machine five times
([what is known](MEASUREMENTS.md#freezes)). If the machine freezes with -25, delete `--set-coall=1048551` from
the unit. The watchdog resets the machine once the kernel has hung for 30 seconds, so a hang ends in a reboot, and
the next boot says so.

**AI server**:

```sh
sudo dnf copr enable -y shdwchn10/ryzenadj
sudo dnf install -y ryzenadj
sudo install -m 644 ~/workspace-portal/llm-server/apu-tuning.service /etc/systemd/system/
sudo install -D -m 644 ~/workspace-portal/llm-server/watchdog.conf /etc/systemd/system.conf.d/watchdog.conf
sudo systemctl daemon-reload
sudo systemctl enable --now apu-tuning.service
sudo systemctl daemon-reexec
```

**AI server**, check:

```sh
sudo ryzenadj --info | grep -E 'STAPM LIMIT|PPT LIMIT (FAST|SLOW)|THM LIMIT'
systemctl show -p RuntimeWatchdogUSec
cat /sys/class/watchdog/watchdog0/state
```

**You should see** the limits `132.000`, `160.000`, `140.000` and `98.000`, then `RuntimeWatchdogUSec=30s` and
`active`.

> **Other machines with this board** were not tested: the upstream driver's README lists the GMKtec EVO-X2, FEVM
> FA-EX9, Peladn YO1, NIMO AI MiniPC and Corsair AI Workstation 300. The duty registers this driver writes are not
> part of the upstream driver, so do not edit the board check to get past it.

<details>
<summary>Quieter profiles, and how to undo the step</summary>

| Profile | Sustained / peak | Cost |
|---|---|---|
| `performance` | 120 W / 160 W; 132 W / 160 W with the unit above | Fastest. Used for every number in this guide. |
| `balanced` | 85 W / 120 W | Less heat and noise. |
| `quiet` | 55 W / 100 W | Prompt reading 28% slower. |

Switch live, until the next boot:

**AI server**:

```sh
echo balanced | sudo tee /sys/class/ec_su_axb35/apu/power_mode
```

To keep another profile across boots, change the word `performance` in `/etc/systemd/system/m5-fans.service`, run
`sudo systemctl disable apu-tuning.service`, whose limits would undo the quieter profile, then `sudo systemctl
daemon-reload` and `sudo systemctl restart m5-fans.service`. Running the installer again puts `performance` back.
Switching a profile also resets the power limits: after switching back to `performance` by hand, `sudo systemctl
start apu-tuning.service` raises them again.

Undo: removes the driver, the fan curve and its service, and the firmware has the fans again. The power profile
stays as it is, so switch it with the line above first if you want another.

**AI server**:

```sh
sudo bash ~/workspace-portal/llm-server/fans/install.sh uninstall
```

**You should see**, as the last line, `install.sh: removed; the firmware controls the fans`

</details>

### 8. Start the models

*AI server*

Installs [llama-swap](https://github.com/mostlygeek/llama-swap) and Gufo 0.37.0 with the LLM: four 256K sessions,
MTP and vision. The image and media models of the [next step](#media-models) don't fit in memory beside it, so
llama-swap gives them all one address, port 8080, and runs the model a request names: the LLM from boot on, another
model when it is asked for, the LLM again with the next chat request. It stops the running model first, once its
requests have finished. The LLM keeps conversations on disk as well as in RAM, so
after a swap or a restart an agent's next turn resumes instead of reading its whole conversation again.

**AI server**:

```sh
mkdir /models/gufo-cache /models/gufo-models
chattr +m /models/gufo-cache /models/gufo-models
mkdir /models/gufo-cache/disk /models/gufo-cache/home
podman unshare chown 1000:1000 /models/gufo-cache/disk /models/gufo-cache/home
podman pull "$(sed -n 's/^Image=//p' ~/workspace-portal/llm-server/gufo.container)"
```

**AI server**:

```sh
mkdir -p ~/.local/bin ~/.local/lib/llama-swap ~/.config/llama-swap ~/.config/systemd/user ~/.config/containers/systemd
cd ~/workspace-portal/llm-server
sh apps/llama-swap/install.sh 277 ~/.local/lib/llama-swap/277
echo 277 > ~/.local/lib/llama-swap/277/.portal-version
ln -s 277 ~/.local/lib/llama-swap/current
install -m 755 wait-gpu-memory ~/.local/bin/
cp gufo.container ~/.config/containers/systemd/
cp llama-swap.yaml ~/.config/llama-swap/config.yaml
cp llama-swap.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now llama-swap.service
```

llama-swap's release is checked against the checksums GitHub publishes with it. Each release gets a folder of its
own under `~/.local/lib/llama-swap`, and `current` points at the one that runs: that is how **Admin > Updates**
installs a newer one beside it and can switch back.

Neither Gufo nor llama-swap has a login. The models listen on this machine only (ports 18080 to 18091); this lets
the portal server, and nobody else, reach llama-swap on port 8080.

**AI server**:

```sh
sudo firewall-cmd --permanent --zone=FedoraServer \
  --add-rich-rule='rule family="ipv4" source address="PORTAL_IP/32" port port="8080" protocol="tcp" accept'
sudo firewall-cmd --reload
```

**AI server**, check:

```sh
until curl -s http://127.0.0.1:8080/running | grep -q '"state":"ready"'; do sleep 2; done
curl -s http://127.0.0.1:8080/running | jq -c '[.running[] | {model, state}]'
curl -s http://127.0.0.1:18080/props \
  | jq -c '{total_slots, build_info, n_ctx: .default_generation_settings.n_ctx, vision: .modalities.vision}'
```

**You should see**

```text
[{"model":"qwen3.8-flash-next","state":"ready"}]
{"total_slots":4,"build_info":"0.37.0 (684b716)","n_ctx":262144,"vision":true}
```

Measured on the test machine, with the model files already in the page cache:

| What happens | Time to the answer |
|---|---|
| llama-swap starts at boot and loads the LLM | 18 s |
| A chat request after another model ran, which llama-swap stops first | 17.3 s |

> Each session has 262,144 tokens, all the model takes, for everything: instructions, tools, history, thinking and
> the answer. Qwen Code asks for replies of up to 64,000 tokens, and a client that names no limit gets the same
> (`--max-tokens`). Thinking is part of a reply and ends after 32,000 tokens (`--reasoning-budget`), which leaves
> the other half of a full reply for the answer. Summarizing a 93,700-token document took 26,300 tokens of thinking
> and a 26,000-token answer at the highest effort, 390 and 7,500 at `low` ([measurements](MEASUREMENTS.md#replies-and-thinking)).

> **Swaps.** llama-swap waits for the requests in flight to finish before it stops a model, without a time limit,
> and holds new requests meanwhile. So an image waits for every running LLM request, and chat requests wait for
> the image. Each model's unit first waits, up to 60 seconds, until the memory the previous model used is free
> again (`wait-gpu-memory`: 90 GiB for the LLM): a model that loads while the last one still lets go can fail to
> load or hang a Strix Halo machine ([gufo#1394](https://github.com/gufo-org/gufo/issues/1394)).

> The disk cache (`--cache-disk`) takes up to 32 GiB in `/models/gufo-cache/disk`. Gufo runs as user 1000 in its
> container, hence `podman unshare chown`. A conversation that no longer fits the 4 GiB in RAM, or that a restart
> or a swap cut off, resumes from there: Gufo's docs give 1.8 s instead of about 50 s for a 24,866-token prompt.
> Gufo writes each conversation once, then what each turn adds. The conversations stay there as the model's token
> ids until the cache needs the room; deleting a person's data in the portal does not remove them. With the disk
> cache on, Gufo hashes the model files when it starts and keeps the result in `/models/gufo-cache/home`, so only
> the first start pays for it. `chattr +m` stops btrfs from compressing what the cache and the downloads write.

<a id="layouts"></a>

<details>
<summary>Other session layouts</summary>

Change `--sessions` and `--context` in `~/.config/containers/systemd/gufo.container`, then run the lines below.
What the disk cache holds was made for the old layout: Gufo cannot use it and does not delete it, so they empty
it while the models are stopped.

```sh
systemctl --user daemon-reload
systemctl --user stop llama-swap.service
podman unshare sh -c 'rm -rf /models/gufo-cache/disk/*'
systemctl --user start llama-swap.service
```

| Layout | Flags | Use it when |
|---|---|---|
| **4 × 256K** | `--sessions 4 --context 262144` | Long tasks. The layout of this guide. |
| **7 × 128K** | `--sessions 7 --context 131072` | More people or subagents at once, with shorter conversations. An eighth session is refused at load. |
| **3 × 256K** | `--sessions 3 --context 262144` | Agents on the same machine. |

For another layout, set `LLM_MAX_CONCURRENCY` in [step 10](#10-workspace-portal) to its sessions, and after that
step give the agents its context (here 131072):

**Portal server**:

```sh
cd ~/workspace-portal
sed 's|"contextWindowSize": 262144|"contextWindowSize": 131072|' \
  models/system-defaults.json > /tmp/system-defaults.json
sudo bash deploy/models.sh install /tmp/system-defaults.json
```

With 128K sessions also set `--reasoning-budget 16000`: there Qwen Code's replies shrink to 29,000 tokens before it
compacts a conversation. The load test of [step 9](#9-test-it) takes `--users 7 --target 128000` or `--users 3
--target 256000`. Memory and timings of all three layouts are in [MEASUREMENTS.md](MEASUREMENTS.md#memory); replies
of this size were run with four sessions only.

</details>

### Media models

*AI server · optional*

Adds the models behind OpenCode's image and media tools: images, video clips with sound, music, speech and
transcription. Each kind has a fast model for drafts and everyday work and a quality one for final work, and the
agent picks one for each call; one image model does both. llama-swap serves them on port 8080, as it serves the
LLM. Without this step OpenCode makes no images or media.

| Kind | Fast | Quality |
|---|---|---|
| Images | Ming-Image 0.2 Design: text to image and editing, up to 4.5 megapixels | the same model |
| Video with sound | MiniMax H3 with its fast preset, 512x512 | MiniMax H3, 512x512 or 1344x768 |
| Music | ACE-Step 1.5 XL turbo | ACE-Step 1.5 XL |
| Speech | Qwen3-TTS 1.7B: nine built-in voices, a voice described in words, or one cloned from a recording | Fish Audio S2-Pro |
| Transcription | Qwen3-ASR 1.7B: text | SOV-Transcribe-1: text |

The fast speech and transcription models run beside the LLM, which keeps running. Every other media model stops
the LLM while it works, the image model included. A video holds the AI server until it is downloaded: meanwhile
every other request waits in the portal, and each person's workspace says why.

> **Licences.** Read them before the download: none of these models is under the portal's licence. Read on
> November 27, 2026:
>
> - **MiniMax H3**
>   ([MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/LICENSE),
>   August 2, 2026) grants nothing in the United States, the European Union, the United Kingdom or South Korea.
>   There neither the model nor its videos may be used without a separate licence from MiniMax, which the
>   agreement invites people there to ask for. Elsewhere, products that earn more than US$20 million a year need
>   MiniMax's written consent, a commercial product must show "MiniMax H3" on its interface, and machine-made
>   content posted in public must say that it is.
> - **Fish Audio S2-Pro**
>   ([Fish Audio Research License](https://huggingface.co/fishaudio/s2-pro/blob/1de9996b6be38b745688de084d87a5633f714e4e/LICENSE.md),
>   March 7, 2026): research and non-commercial use only. Commercial use, a business's internal work included,
>   needs a separate licence from Fish Audio. Its outputs may not be used to build or improve a foundation model.
>   fish-speech, the program that runs it, is under another licence, the
>   [Fish Audio Community License](https://github.com/fishaudio/fish-speech/blob/v3.0.0-beta/LICENSE).
> - **LTX-2.5** ([LTX-2.x Community License Agreement](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x),
>   August 11, 2026, amended November 11, 2026), the optional model [below](#ltx-25): free for any purpose within
>   the use restrictions of its Attachment A, but a company with yearly revenue of US$10 million or more needs a
>   paid licence for any use that is not non-commercial. Its download needs a Hugging Face account that accepted
>   the licence.
> - **Ming-Image-0.2-Design** and **ACE-Step 1.5** are under the MIT licence; Qwen3-TTS, Qwen3-ASR and
>   SOV-Transcribe-1 are under Apache 2.0.

Checks the free space. The models take 331 GB in `/models`, 403 GB with LTX-2.5. On `/` the test machine holds 29 GiB
of programs in `/opt/ai-studio` (LTX-2.5's included), vLLM's 12.4 GB image and 16 GiB of uv's downloads in
`~/.cache/uv`.

**AI server**:

```sh
df -h /models /
```

**You should see** at least `335G` free on `/models` and `60G` on `/`.

Installs uv and FFmpeg, which the media programs build and run with, and their folders. `/etc/ai-studio/cache.env`
names the folders in `/var/cache/ai-studio` where they keep what they compile and download, so a swap or a reboot
does not do it again; `/etc/profile.d/ai-studio-cache.sh` gives your shell the same names. MiniMax H3 keeps its
jobs and their MP4s in `/models/gufo-cache/video-jobs` for an hour, as user 1000 of its container.

**AI server**:

```sh
sudo dnf install -y uv ffmpeg-free
cd ~/workspace-portal/llm-server
sudo install -D -m 644 media/cache.env /etc/ai-studio/cache.env
sudo install -m 644 media/ai-studio-cache.sh /etc/profile.d/
sudo install -d -o "$USER" -g "$(id -gn)" /opt/ai-studio /var/cache/ai-studio
mkdir -p /opt/ai-studio/ming /opt/ai-studio/fish-speech /opt/ai-studio/acestep /opt/ai-studio/vllm-sov
mkdir -p /var/cache/ai-studio/{hf,torch,triton,miopen,vllm,comgr}
mkdir -p /models/gufo-cache/video-jobs
podman unshare chown 1000:1000 /models/gufo-cache/video-jobs
```

Downloads MiniMax H3, Qwen3-TTS's Base model (the one that clones voices) and Qwen3-ASR through Gufo, as in step
8, at the revisions Gufo 0.37.0 pins. The rest follows from Hugging Face. At the 38 MB/s of step 6 all of it takes
about two hours (an estimate).

**AI server**, inside tmux (`tmux new-session -A -s setup`):

```sh
GUFO_IMAGE=$(sed -n 's/^Image=//p' ~/workspace-portal/llm-server/gufo.container)
podman run --rm --user 0 -e GUFO_MODELS_DIR=/models -v /models/gufo-models:/models:z "$GUFO_IMAGE" \
  sh -c 'gufo model install minimax-h3 && gufo model install qwen3-tts && gufo model install qwen3-asr'
```

**You should see** the three downloads end without an error: 153 GB together.

Fetches the other models from fixed revisions with the Hugging Face CLI of [step 6](#6-download-the-model), and
checks each file against the SHA256 the Hub lists for it. Each download runs as a unit of its own whose file cache
stays within 10 GiB (`MemoryHigh`), as the LLM runs meanwhile.

**AI server**, inside tmux:

```sh
hf() { systemd-run --user --wait --pipe --collect -p MemoryHigh=10G -E HF_HUB_DISABLE_TELEMETRY=1 ~/.hf-cli/bin/hf "$@"; }
fetch() { hf download "$1" --revision "$2" --local-dir "$3" "${@:4}" && hf cache verify "$1" --revision "$2" --local-dir "$3"; }
mkdir -p /models/Ming-Image-0.2-Design /models/fishaudio-s2-pro /models/ACE-Step-1.5 /models/SOV-Transcribe-1 \
  /models/SOV-Transcribe-1-DFlash
chattr +m /models/Ming-Image-0.2-Design /models/fishaudio-s2-pro /models/ACE-Step-1.5 /models/SOV-Transcribe-1 \
  /models/SOV-Transcribe-1-DFlash
fetch inclusionAI/Ming-Image-0.2-Design 3538f4c311cf8f5256d631ddb7f47793f741aa2e /models/Ming-Image-0.2-Design \
  --exclude 'assets/*'
fetch Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice 0c0e3051f131929182e2c023b9537f8b1c68adfe /models/gufo-models/qwen3-tts-customvoice
fetch Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign 5ecdb67327fd37bb2e042aab12ff7391903235d3 /models/gufo-models/qwen3-tts-voicedesign
fetch fishaudio/s2-pro 1de9996b6be38b745688de084d87a5633f714e4e /models/fishaudio-s2-pro
fetch ACE-Step/Ace-Step1.5 19671f406d603126926c1b7e2adc169acbcade22 /models/ACE-Step-1.5
fetch ACE-Step/acestep-v15-xl-base 220c1166efbdd9583eafcb12eb160594bbfcb241 /models/ACE-Step-1.5/acestep-v15-xl-base
fetch ACE-Step/acestep-v15-xl-turbo d4a0b288b83ebb7e25a8c0b32c573c22e134e8ee /models/ACE-Step-1.5/acestep-v15-xl-turbo
fetch salesforce-sovereign-intelligence/SOV-Transcribe-1 505d8fae243924c0d8acdc622f7f0abab344eba3 \
  /models/SOV-Transcribe-1 --exclude 'assets/*'
fetch salesforce-sovereign-intelligence/SOV-Transcribe-1-DFlash 8c0b3f3a98507d2e3dd35b1bee0f147fa3bded05 \
  /models/SOV-Transcribe-1-DFlash
```

**You should see**, after each download, `✓ Verified ... file(s) for model '...'. All checksums match.` Before
Ming-Image's and SOV-Transcribe-1's comes a warning that 6 and 3 remote files are missing locally: the
`assets/` folders left out. As in
step 6, a download that stops with an error goes on when you run the block again.

Builds Ming-Image, fish-speech and ACE-Step, each with a Python environment of its own under `/opt/ai-studio`,
pulls vLLM's image and puts the transcription model's vLLM plugin beside it. A version's folder holds
`.portal-version`, and `current` points at the version that runs: that is how **Admin > Updates** installs a newer
one beside it later. Ming-Image has no releases, so its folder is named after the commit it is built from, and
**Admin > Updates** does not offer it: to update it, build a newer commit the same way and point `current` at it.

**AI server**:

```sh
cd ~/workspace-portal/llm-server
bash apps/ming/install.sh d5615110e3ae7d27f270eafe5556d669b2069971 /opt/ai-studio/ming/d561511
echo d561511 > /opt/ai-studio/ming/d561511/.portal-version
ln -s d561511 /opt/ai-studio/ming/current
bash apps/fish-speech/install.sh 3.0.0-beta /opt/ai-studio/fish-speech/3.0.0-beta
echo 3.0.0-beta > /opt/ai-studio/fish-speech/3.0.0-beta/.portal-version
ln -s 3.0.0-beta /opt/ai-studio/fish-speech/current
bash apps/acestep/install.sh 0.1.8 /opt/ai-studio/acestep/0.1.8
echo 0.1.8 > /opt/ai-studio/acestep/0.1.8/.portal-version
ln -s 0.1.8 /opt/ai-studio/acestep/current
podman pull "$(sed -n 's/^Image=//p' vllm-sov.container)"
cp -r /models/SOV-Transcribe-1/vllm_plugin /tmp/sov-plugin
uv pip install --no-deps --python-version 3.12 --python-platform x86_64-manylinux_2_28 \
  --target /opt/ai-studio/vllm-sov/site-packages /tmp/sov-plugin soundfile==0.14.0 av==19.0.2 soxr==1.1.0
```

**You should see** `installed Ming-Image d561511 in /opt/ai-studio/ming/d561511`, then `installed fish-speech
3.0.0-beta in /opt/ai-studio/fish-speech/3.0.0-beta`, later
`installed ACE-Step 0.1.8 (...) in /opt/ai-studio/acestep/0.1.8`, and at the end uv's list of what it installed.

Puts the units in place. Like the LLM's, they have no `[Install]`: llama-swap starts each with its first request
and stops it when a model of another group is asked for. They listen on this machine only (ports 18081 to 18091),
so the firewall stays as it is. Restarting llama-swap stops every model and loads the LLM again.

**AI server**:

```sh
cd ~/workspace-portal/llm-server
cp gufo-video.container gufo-tts.container gufo-tts-clone.container gufo-tts-design.container gufo-asr.container \
  vllm-sov.container ~/.config/containers/systemd/
cp media/ming.service media/fish-speech.service media/acestep.service ~/.config/systemd/user/
cp llama-swap.yaml ~/.config/llama-swap/config.yaml
systemctl --user daemon-reload
systemctl --user restart llama-swap.service
```

**AI server**, check speech and transcription beside the LLM:

```sh
until curl -s http://127.0.0.1:8080/running | grep -q '"state":"ready"'; do sleep 2; done
curl -s http://127.0.0.1:8080/v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-tts-1.7b","input":"The portal can speak now.","voice":"ryan","language":"english","response_format":"wav"}' \
  -o /tmp/speech.wav
ffprobe -v error -show_entries stream=codec_name,sample_rate,channels -of compact /tmp/speech.wav
curl -s http://127.0.0.1:8080/v1/audio/transcriptions -F model=qwen3-asr-1.7b -F response_format=json \
  -F file=@/tmp/speech.wav | jq -r .text
curl -s http://127.0.0.1:8080/running | jq -c '[.running[] | {model, state}]'
```

**You should see** `stream|codec_name=pcm_s16le|sample_rate=24000|channels=1`, the sentence back as text, and two
models `ready`: `qwen3.8-flash-next` and `qwen3-asr-1.7b`. The LLM kept running, and the transcription model took
the speech model's place: one of the four everyday speech models runs at a time.

**AI server**, check music, the quality speech model and the quality transcription model. Each of them stops the LLM:

```sh
curl -s http://127.0.0.1:8080/upstream/acestep-1.5-xl-turbo/v1/audio/music -H 'Content-Type: application/json' \
  -d '{"model":"acestep-1.5-xl-turbo","prompt":"calm solo piano","duration":30,"response_format":"wav"}' \
  -o /tmp/music.wav
ffprobe -v error -show_entries stream=codec_name,sample_rate,channels -of compact /tmp/music.wav
curl -s http://127.0.0.1:8080/v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"model":"fish-s2-pro","input":"The portal can speak now.","response_format":"wav"}' -o /tmp/fish.wav
ffprobe -v error -show_entries stream=codec_name,sample_rate,channels -of compact /tmp/fish.wav
curl -s http://127.0.0.1:8080/v1/audio/transcriptions -F model=sov-transcribe-1 -F response_format=json \
  -F file=@/tmp/fish.wav
```

**You should see**

```text
stream|codec_name=pcm_s16le|sample_rate=48000|channels=2
stream|codec_name=pcm_s16le|sample_rate=44100|channels=1
```

and then the sentence back as `{"text":...}`. Neither transcription model writes subtitles: vLLM 0.32.0 answers SOV's
`srt`, `vtt` and `verbose_json` with 400, so OpenCode's transcribe_audio offers text only. Music goes to
`/upstream/<model>/` because llama-swap has no route of its own for it, nor for videos; the portal sends both there
too (`MEDIA_MODEL_PATH`).

**AI server**, check the image model. It stops the LLM too:

```sh
curl -s http://127.0.0.1:8080/v1/images/generations -H 'Content-Type: application/json' \
  -d '{"model":"Ming-Image-0.2-Design","prompt":"A red ceramic teapot on a wooden table","seed":42}' \
  | jq -r '.data[0].b64_json' | base64 -d > /tmp/teapot.png && file /tmp/teapot.png
```

**You should see** `/tmp/teapot.png: PNG image data, 1024 x 1024, 8-bit/color RGBA, non-interlaced` after about
50 seconds: 20 to stop the LLM and load Ming-Image, 30 for the image. The same seed gives the same image.

Checks the video model: about 4 minutes once H3 is loaded, longer while it loads. Run it while the portal sends
nothing: a request for any other model would stop H3, and the job with it. The portal holds every other request
until its own video is downloaded, but these commands go around the portal.

**AI server**:

```sh
v=http://127.0.0.1:8080/upstream/minimax-h3/v1/videos
id=$(curl -s $v -H 'Content-Type: application/json' -d '{"model":"minimax-h3","prompt":"A red ceramic teapot on a wooden table, steam rising","size":"512x512","seconds":5,"gufo":{"preset":"fast"}}' | jq -r .id)
while curl -s $v/$id | jq -r .status | grep -qxE 'queued|in_progress'; do sleep 10; done
curl -s $v/$id | jq -r .status
curl -s $v/$id/content -o /tmp/teapot.mp4
ffprobe -v error -show_entries stream=codec_name,width,height,sample_rate,channels -of compact /tmp/teapot.mp4
```

**You should see**

```text
completed
stream|codec_name=h264|width=512|height=512
stream|codec_name=aac|sample_rate=32000|channels=2
```

The next chat request stops H3 and starts the LLM again. Measured on the test machine with Gufo 0.37.0:

| What happens | Time |
|---|---|
| An image, Ming-Image, 1024x1024 | 51.3 s, the LLM stopped first; 30.5 s once loaded, as at 1344x768. 2048x2048: 191 s. An edit of a 1024x1024 image: 79 s |
| A video, H3's fast preset, 5 s at 512x512 | 220.9 s from the request to the finished job, an image model stopped first; 205.3 s with H3 loaded. Decoding the video takes about 118 s of it, longer than the denoising |
| A video, H3's default (exact) preset, the quality tier, 5 s at 512x512 | 1,056 s (17.6 minutes); 1,101 s starting on a first frame |
| A video at 1344x768, exact preset | Not run to the end: 95.4 s for each of its 49 denoising steps, six times a 512x512 step. That is about 78 minutes of denoising and about 95 minutes in all (an estimate), with the AI server busy throughout |
| Music, ACE-Step 1.5 XL turbo / XL | 1.7 to 3.2 s for 10 to 30 s of music, 29.7 s for 30 s with the swap from SOV-Transcribe-1 / 15.1 s for 30 s, 39.1 s with the swap from Fish S2-Pro |
| Speech, Qwen3-TTS | 0.38 to 0.42 s for each second of speech: 2.8 s for 7.1 s once it is loaded, 5.3 s for the first request after it starts. Its transcript matched the text word for word |
| Speech, Fish S2-Pro | 2.1 s for each second of speech: 16.5 s for 7.8 s, 53.3 s with the swap from H3. A cloned voice: 18.4 to 19.2 s |
| Transcription, Qwen3-ASR | 12.5 s of speech in 0.80 s; 34.6 s in 2.3 s once it is loaded, 4.9 s for the first request; 5 minutes in 24 to 25 s (0.97% and 2.8% of the words wrong in two recordings); 25 minutes in 113 s, 1.64% wrong |
| Transcription, SOV-Transcribe-1 | 34.6 s of speech in 1.5 s; 5 minutes in 44 s, 2.9% of the words wrong; eight 5-minute files at once in 97 s. It takes 86 to 89 s to start, the swap included |
| A chat request after any of these, which llama-swap stops first | 18.6 to 20.4 s |

> **Beside the LLM.** Qwen3-TTS takes a language by its full name: `english`, `chinese`, `german`, `italian`,
> `portuguese`, `spanish`, `japanese`, `korean`, `french` or `russian`; a code such as `en` gets HTTP 500. A
> request speaks up to 240 s, and the tool sends longer text in pieces of about 1,200 characters. Qwen3-ASR takes
> up to 30 minutes and 64 MiB a file in WAV, FLAC, MP3 or Ogg, not M4A, AAC or WebM (the tool converts to FLAC
> first), and writes no times. A speech or transcription model stays loaded beside whatever runs until another one
> takes its place or five minutes after its last request. Both slow the LLM down while they work: it wrote 44.6 to
> 45.5 tok/s alone, 38 to 39 while Qwen3-TTS spoke (which then took 0.99 s for each second of speech), and 26 to 29
> while Qwen3-ASR transcribed.

> **Memory.** The LLM alone leaves 25.6 GiB free (`MemAvailable`). Beside it, one Qwen3-TTS model leaves 18.4 GiB
> idle and 15.2 GiB after use, Qwen3-ASR 20.2 and 19.9. A Qwen3-TTS model takes 7.0 to 7.3 GiB loaded and about
> 10 GiB once it has made a WAV of 24 s or more; Qwen3-ASR 5.1 GiB. Two of them together left 9.3 to 9.9 GiB after
> use, and a third exceeded the GPU's eight compute queues (Gufo warns `queue_budget_exceeded`; the idle power rose
> from 7.2 to 30.4 W): llama-swap runs one at a time. Of the others, H3 peaked at 34.3 GiB of GPU memory with its
> fast preset and 39.3 GiB with its exact one, ACE-Step at 24.9 GiB and Fish S2-Pro at 22.5 GiB. SOV-Transcribe-1's
> KV cache is capped at 36 GiB (`llm-server/vllm-sov.container`): it peaks at 89.4 GiB and leaves 28.4 GiB free, room
> for an everyday speech model beside it. Ming-Image takes 46.4 GiB loaded and at most 53.7 GiB while it makes an
> image, at 2048x2048 too: its server decodes images larger than 1024 pixels in tiles, without which 2048x2048 took
> 89 GiB. Beside it Qwen3-TTS spoke in 4.0 s and the next image took as long as before. The least free memory
> measured with a speech model beside another model was 15.9 GiB: the LLM, with Qwen3-TTS speaking 24.6 s.

Names the media models for the portal and restarts its gateway. Video and music also need
`MEDIA_MODEL_PATH=/upstream/{model}` in `.env`, because llama-swap serves them only under `/upstream/<model>/`:
step 10 sets it, and the first line here sets it on a portal installed before.

**Portal server**, once [step 10](#10-workspace-portal) is done (a portal installed before: after [Update the
portal](#update-the-portal)):

```sh
cd ~/workspace-portal
sed -i 's|^MEDIA_MODEL_PATH=.*|MEDIA_MODEL_PATH=/upstream/{model}|' .env
sudo bash deploy/models.sh install llm-server/media.json
```

**You should see** `installed /srv/workspace-portal/config/models/media.json`, then `the gateway restarted with the
new media.json`. It refuses while **Admin > Updates** runs an update or a video is being made, since the restart
would cut either off. Workspaces get the media tools at their next start.

#### LTX-2.5

*AI server · optional, off by default*

LTX-2.5 22B distilled can take the place of H3's fast preset as the fast video model: 512x512, 1344x768 or
768x1344, 1 to 20 seconds. Nothing of it was measured: the test machine has its program but not its weights. The
weights are 72.6 GB on disk and take about 66.2 GiB of GPU memory (an estimate from their sizes). Read its licence
[above](#media-models) first.

Turn it on only once its weights pass the check below. Without them its server stays up but answers 503, and a
request for it would stop the LLM and then wait out llama-swap's 600-second health check.

Accept the licence at [huggingface.co/Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5) with your
Hugging Face account, and create a read token at
[huggingface.co/settings/tokens](https://huggingface.co/settings/tokens). Then build LTX-2 1.6.3 like the other
media programs, put its unit in place and save the token; paste it when asked.

**AI server**:

```sh
cd ~/workspace-portal/llm-server
mkdir -p /opt/ai-studio/ltx
bash apps/ltx/install.sh 1.6.3 /opt/ai-studio/ltx/1.6.3
echo 1.6.3 > /opt/ai-studio/ltx/1.6.3/.portal-version
ln -s 1.6.3 /opt/ai-studio/ltx/current
cp media/ltx.service ~/.config/systemd/user/
systemctl --user daemon-reload
HF_TOKEN_PATH=$HOME/.cache/huggingface/token /opt/ai-studio/ltx/current/.venv/bin/hf auth login
```

**You should see** `installed LTX-2 1.6.3 (...) in /opt/ai-studio/ltx/1.6.3`, and after the token the login's
success.

Downloads the six files at a fixed revision: the model, its text encoder, the audio decoder, the upscaler and both
video decoders.

**AI server**, inside tmux:

```sh
rev=69ecadd4932572caf956135d41cbcdbd697aa442
sudo install -d -o "$USER" -g "$USER" /models/LTX-2.5
sudo chattr +m /models/LTX-2.5
systemd-run --user --wait --pipe --collect -p MemoryHigh=10G \
  -E HF_TOKEN_PATH=$HOME/.cache/huggingface/token -E HF_HUB_DISABLE_TELEMETRY=1 \
  /opt/ai-studio/ltx/current/.venv/bin/hf download Lightricks/LTX-2.5 --revision $rev --local-dir /models/LTX-2.5 \
  diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors \
  text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors \
  vae/ltx-2.5-video-vae-conv-bf16.safetensors \
  vae/ltx-2.5-audio-vae-bf16.safetensors \
  latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors \
  vae/ltx-2.5-video-vae-bf16.safetensors
```

Checks each file against its SHA-256. `iflag=direct` reads the 72.6 GB past the page cache.

**AI server**:

```sh
cd /models/LTX-2.5
while read -r sum file; do
  got=$(nice dd if="$file" iflag=direct bs=16M status=none | sha256sum | cut -d' ' -f1)
  if [ "$got" = "$sum" ]; then echo "OK      $file"; else echo "FAILED  $file"; fi
done <<'EOF'
31eb3cad89b9e54e99dd3baf286f70825ac4f6c660a70d9184d895be76d7bff4 diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors
ef7243612fdae7a75cb4d5cee9433e81380675fb6c213bd98ae74a9cd16561d1 text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors
685b06ee3d9b2039647698fc4ea33175112462fc374e2777312c907897dfce8d vae/ltx-2.5-video-vae-conv-bf16.safetensors
c52733d37f6a7fb7949c3dc0fb468c6cb2169e4d836983a73babb9f0d54837a5 vae/ltx-2.5-audio-vae-bf16.safetensors
eb5a71fe4068ee87ccdb1c3aa635e547ca76bd2d30ae20ae889f2c325c0677e8 latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors
847e14ca7f3355debca0cea4eaa24ac0fbcdf0061da054ac89ca638a869ddba3 vae/ltx-2.5-video-vae-bf16.safetensors
EOF
```

**You should see** six lines that start with `OK`. Delete a file marked `FAILED` and run the download again.

Turns LTX-2.5 on in llama-swap: its entry, commented out in the configuration, and its place in the `media` group.
A later copy of `llm-server/llama-swap.yaml` turns it off again; run these lines after it. The restart stops every
model. As with H3, run the check while the portal sends nothing.

**AI server**:

```sh
sed -i -e 's|^  # ltx-2.5-distilled:$|  ltx-2.5-distilled:|' \
  -e '/^  ltx-2.5-distilled:$/,/checkEndpoint/s|^  #   |    |' \
  -e 's|acestep-1.5-xl-base\]$|acestep-1.5-xl-base, ltx-2.5-distilled]|' ~/.config/llama-swap/config.yaml
systemctl --user restart llama-swap.service
until curl -s http://127.0.0.1:8080/running | grep -q '"state":"ready"'; do sleep 2; done
v=http://127.0.0.1:8080/upstream/ltx-2.5-distilled/v1/videos
id=$(curl -s $v -H 'Content-Type: application/json' -d '{"model":"ltx-2.5-distilled","prompt":"A red ceramic teapot on a wooden table, steam rising","size":"512x512","seconds":5}' | jq -r .id)
while curl -s $v/$id | jq -r .status | grep -qxE 'queued|in_progress'; do sleep 10; done
curl -s $v/$id | jq -r .status
```

**You should see** `completed` as the last line.

Makes LTX-2.5 the fast video model for the portal. Its 20 seconds are the program's limit, not a tested length.

**Portal server**:

```sh
cd ~/workspace-portal
python3 -I - /tmp/media.json <<'EOF'
import json, re, sys
media = json.loads(re.sub(r"(?m)^//.*$", "", open("llm-server/media.json").read()))
media["video"]["fast"] = {"model": "ltx-2.5-distilled", "name": "LTX-2.5 22B distilled", "sizes": ["512x512", "1344x768", "768x1344"], "seconds": {"min": 1, "max": 20}}
json.dump(media, open(sys.argv[1], "w"), indent=2)
EOF
sudo bash deploy/models.sh install /tmp/media.json
```

**You should see** `the gateway restarted with the new media.json`.

### 9. Test it

*AI server*

**Tool call.** Agents depend on these: the model must answer with a call, not with prose.

**AI server**:

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

**AI server**:

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
keys in it and pass them to a tool, and watches memory while it runs. The run takes about 19 minutes and occupies
the whole server, so do it before anyone depends on it. It talks to Gufo directly, on port 18080, so the LLM must be
the model llama-swap runs: after the tool call above it is.

**AI server**:

```sh
python3 ~/workspace-portal/llm-server/acceptance.py
```

**You should see** one line per session, one line of readings, and both verdicts:

```text
Prompts: 4 of 255997 to 256000 tokens. Sending them all at once.
user 0: first word after 293.5 s, follow-up after 289.3 s: PASS
...
Sessions busy at once: 4 of 4. Lowest free memory: 13.2 GiB. Swap pages moved: 0. Killed for memory: 0. Hottest: 103 °C.
FUNCTIONAL PASS
CAPACITY PASS
```

> With the limits of step 7 the chip holds its 98 °C limit for most of the run, both fans at their top speed. The
> follow-ups' times vary from about 150 to 480 seconds: Gufo often reclaims a waiting session's memory, and the
> follow-up then reads its prompt again.

## Part 3: Portal server

The small second PC. Steps 10 and 11.

### 10. Workspace Portal

*Portal server · about 12 min*

Installs Docker and [Workspace Portal](https://github.com/ShahriarDhruvo/workspace-portal), points it at the LLM
server, and sizes it for an 8 GB machine: three workspaces of at most 2.25 GiB each. The installer builds the
images, loads the firewall and starts the portal, its own SearXNG for web search, and the page reader that lets
agents open the pages they find. On the 2-core test machine that took 7.5 minutes with one agent enabled; the
images of the other two, built by hand, took 4 more.

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
  -e 's|^MEDIA_MODEL_PATH=.*|MEDIA_MODEL_PATH=/upstream/{model}|' \
  -e 's|^LLM_SLOTS_PATH=.*|LLM_SLOTS_PATH=/upstream/qwen3.8-flash-next/slots|' \
  -e 's|^WORKSPACE_MEMORY=.*|WORKSPACE_MEMORY=2304m|' \
  -e 's|^WORKSPACE_CPUS=.*|WORKSPACE_CPUS=1.5|' \
  -e 's|^MAX_RUNNING_WORKSPACES=.*|MAX_RUNNING_WORKSPACES=3|' .env
curl -s -o /dev/null -w 'model server: %{http_code}\n' http://LLM_IP:8080/health
sudo bash deploy/install.sh
```

**You should see** `model server: 200` before the build starts, and at the end:

```text
  Workspace Portal is running.

    Portal:     http://PORTAL_IP:3000
    Workspaces: ports 12020-13999 (each workspace has its own: one per user, agent and kind)
    Previews:   ports 22020-23999 (the apps running in a workspace, 10000 above its port)
    Online:     on (ONLINE_WORKSPACES; Admin > Users switches it off per user)
    Admin:      admin   (first sign-in: grep ^ADMIN_PASSWORD /home/YOUR_LOGIN/workspace-portal/.env; you choose a new one then)
    Agent:      Qwen Code 0.27.0
    Agent:      DeepSeek Harness 0.2.2-rc.1
    Agent:      OpenCode 2.4.1
    Models:       /srv/workspace-portal/config/models (deploy/models.sh; used by every agent)
    Instructions: /srv/workspace-portal/config/instructions.md (every agent is told them)
    Web:        web_search through the built-in SearXNG (http://127.0.0.1:8888); page reader on (read_page)
    Monitoring: this server: portal-hostd on http://127.0.0.1:9180; AI server: not set up (hostd/README.md)

  Check the workspace isolation at any time:  sudo bash deploy/verify-isolation.sh
```

The installer's own `media.json` names no image or media model, and with it OpenCode makes none: the [media
models](#media-models) step installs `llm-server/media.json` once its models are on the AI server.

Checks that the workspaces are sealed, runs one search, and prints the first admin password.

**Portal server**:

```sh
cd ~/workspace-portal
sudo bash deploy/verify-isolation.sh
curl -s 'http://127.0.0.1:8888/search?q=fedora+linux&format=json' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d["results"]), "results, engines that failed:", d["unresponsive_engines"])'
grep ^ADMIN_PASSWORD .env
```

**You should see** one `PASS` line per check and a last line with `failed 0`, after about 6.5 minutes on the
2-core test machine: most of that is waiting for connections that must fail. The count before it grows with the
setup and with the workspaces people have used: `passed 296` on the test machine with one agent enabled and no
workspace started yet. Then a line like
`33 results, engines that failed: []`: an engine named in the brackets was turned away this time and comes back by
itself.

Open `http://PORTAL_IP:3000`, sign in as `admin` with that password and choose a new one when asked. Create an
account for each person under **Admin > Users > New user**: the portal shows a temporary password once, and the
person chooses their own at the first sign-in.

Each person has a Private and an Online workspace for every agent, and one of them runs at a time. **Private** has
no internet access. **Online** also reaches public internet addresses, but never your LAN, the servers or another
workspace. On Home, press **Start Private** or **Start Online**, then **Open workspace**; with the mouse over the
**i** on a card you read what that kind reaches (a touch screen shows no **i**). The agent is
Qwen Code unless the person picks DeepSeek Harness or OpenCode on Home, under Private and Online, or the
administrator does on the person's page under **Admin > Users**. Every workspace has its own files and chats, so a
switch to another agent is a switch to that agent's workspaces, Private and Online: what was made with the agent
before stays in that agent's workspaces and is there again after switching back. A running workspace stays as it
is until it is stopped; the picked agent's starts next time. With **Plan mode** on, in the **+** menu under Qwen
Code's input, the agent changes nothing and runs no command until its plan is approved.

DeepSeek Harness runs as it ships, with its own workspaces, plugins and permission modes; a workspace leaves out
only signing in to DeepSeek, its own web search (the portal's search replaces it) and opening folders in desktop
apps. A new session starts with **Full access**: the agent changes any file and runs any command in the workspace
without asking. The session's permission menu switches it to **Workspace Write**, **Read Only** or **Auto review**,
where the model judges each action first and asks the person about any it would not allow; **Settings** changes the
default for new sessions. A new session also has **agent teamwork** on: the agent and the subagents it starts divide
large tasks on a shared task board, which spends more tokens; **Enable agent teamwork**, in the menu of the session's
model, switches it off for that session.
Its first workspace is `Documents/deepseek-harness/default-workspace` in its home folder;
**Add workspace** opens any other folder. **Plugins**, in its sidebar, switches on the
plugins DeepSeek Harness comes with and, in an Online workspace, installs others from npm or GitHub. A plugin runs
with the person's own access, so install only those you trust. Its dark theme takes the portal's blacks, as Qwen
Code's.

OpenCode (OpenCode 2, the `@opencode/cli` package) also runs as it ships; a workspace leaves out only other model
providers, sharing a session, its own web fetch and search (the portal's search and page reader replace them),
pairing another browser or machine with it, and updating itself. The projects in its sidebar are kept in the
browser, so the first time in a browser choose **Add project**, then **Select folder** in the dialog, which opens
at `/workspace`, the workspace's own folder. **New session** starts a session there; any other folder is added as
a project the same way. The sessions are kept in the workspace: the start page lists them by day, for every
project and in any browser, and searches them. Each session opens in a tab, and <kbd>Ctrl</kbd>+<kbd>&#96;</kbd>
opens a terminal beside it. In a turn, a line such as **Used 1 Shell** opens its tool calls and the model's
reasoning. A model's efforts are its variants in OpenCode's model picker.

The agent changes files and runs commands in the workspace without asking. An `opencode.json` in a project's
folder with `{"permissions": [{"action": "shell", "resource": "*", "effect": "ask"}]}` makes it ask before each
command there.

OpenCode starts with more than it ships with. Two plugins: Superpowers, whose skills make the agent brainstorm,
plan, test first and review, and Safety Net, which refuses commands that destroy work (`git reset --hard`, `rm
-rf` of a home folder) and reads of keys. Four skills, which the agent loads when a task calls for one:
`frontend-design`, `react-best-practices`, `shadcn` and `research`. A file the agent
edits is formatted when a formatter for it is there (gofmt, rustfmt, ruff, shfmt, or the project's prettier). An
Online workspace also has Context7, for a library's current documentation, and grep.app, for code search over
public GitHub repositories; both are public services, so what the agent asks them leaves the portal. The
[architecture notes](ARCHITECTURE.md#opencodes-toolset) say where each comes from and what was left out.

**In every workspace**, whichever agent runs it:

- **Tools.** Node.js 24 with npm and pnpm, Python 3 with uv and ruff, Go, Rust with cargo, rustfmt and clippy, GCC
  and G++ with make and gdb, Bash with shellcheck and shfmt, PowerShell (`pwsh`) and git. They are part of the
  image, because a Private workspace can download nothing; an Online one installs more into its home folder.
  There is no root and no `apt`. `/tmp` runs no program, so build in `/workspace` or the home folder.
- **Preview.** When a web server runs in the workspace, a **Preview** button appears in the portal's bar and opens
  it in a tab of its own; with several servers it lists them. The server must listen on all addresses (`next dev
  -H 0.0.0.0`, `vite --host 0.0.0.0`): one on localhost only is listed with that advice. The agents are told the
  same, so they start servers that way.
- **Instructions.** Every agent is told the facts above, the name of the person it works for, and the place
  picked under **Settings > Electricity price**, if one is. Then come the portal's rules for how to answer and
  how to write code: a fresh install starts with `harnesses/instructions.md`. To change them, edit a copy and
  install it; workspaces read it at their next start. The file applies to every person's agents and may be
  32 KiB long; an empty one means no such rules:

  ```sh
  sudo install -m 0600 my-instructions.md /srv/workspace-portal/config/instructions.md
  ```

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

Everything behind `/llm/api` is what llama-swap passes on to Gufo: Chat Completions, Responses, Anthropic's
Messages, embeddings and images. Software that speaks Anthropic's API takes `http://PORTAL_IP:3000/llm/api` as its
base URL. llama-swap's own routes, which stop models and show everyone's traffic, are left out.
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
share of it, and lets **Admin > Updates** [update Gufo and the AI server's other software](#engine-update). The
portal server's half came with the installer above; this adds the AI server's.

**AI server**:

```sh
sudo bash ~/workspace-portal/hostd/install.sh llm --portal PORTAL_IP --engine-url http://127.0.0.1:18080 \
  --engine-router http://127.0.0.1:8080 qwen3.8-flash-next
```

**You should see**, as the last lines:

```text
install.sh: updates of other software: llama-swap vllm fish-speech acestep ltx
install.sh: engine control: gufo.service (quadlet /home/YOUR_LOGIN/.config/containers/systemd/gufo.container, user YOUR_LOGIN, behind llama-swap at http://127.0.0.1:8080)
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
  reads more. Every agent is told this place too, as the place of the portal's server.
- **Access:** `portal-hostd`, the daemon that takes the readings, listens on 127.0.0.1 only on the portal server.
  On the AI server it listens on port 9180, and its installer adds one firewall rule that lets only the portal
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
| `MEDIA_MODEL_PATH=/upstream/{model}` | Where the AI server answers a video or music model's own routes: llama-swap at `/upstream/<model>/`, which starts that model. Video and music need it, as llama-swap has no route of its own for them; with the default, `none`, they go to its root and get 404. Images, speech and transcription go to llama-swap's own routes either way. |
| `media.json` | Not in `.env`: the image and media models, in `/srv/workspace-portal/config/models`, by kind and tier: a fast model for drafts and everyday work and a quality one for final work, which the agent picks for each call. [Media models](#media-models) installs `llm-server/media.json`, with one image model for both tiers; until then it names none. OpenCode gets a tool for each kind the file names: asked for an image, the agent saves it in the project as `images/<name>.png` and shows it in its reply. With media models it first proposes a plan for several parts, any video or work of more than a few minutes, with each step's tier and estimated time, and starts when the person replies **go**. Images and media share the LLM's queue, and every model but the everyday speech and transcription ones stops the LLM while it works ([swaps](#8-start-the-models)). OpenCode's model picker lists chat models only. `sudo bash deploy/models.sh show` prints the file and `install` replaces it, which restarts the gateway; workspaces get the change at their next start. |
| `LLM_SLOTS_PATH=/upstream/qwen3.8-flash-next/slots` | Where **Admin > Usage** reads the LLM's sessions through llama-swap. It never starts the LLM. While the LLM is stopped for an image or a media model, Usage says what is being made (*Making images*, *Making a video*, *Making music*, *Making speech*, *Transcribing*) and shows no Read or Write rate, since those servers report no tokens. Its generation tile follows the kind being made, or made last: how many are in progress, a video's percent done and time so far, and the median time of the last five per image, video, track, speech request or file. |
| `DEFAULT_REASONING_EFFORT=low` | The default. Every new agent session starts at low effort, which answers faster; raise it inside a session for a hard task. `medium` and `xhigh` are this model's other two efforts. |
| `WORKSPACE_AGENTS=qwen,dsh,opencode` | The default: the agents people choose from, the first being a new person's. One that is left out is off everywhere: Home does not show it, its ports are closed, its image is not built, and a workspace of it that still runs is stopped. Its people's files stay, and are there again when it comes back. `WORKSPACE_AGENTS=opencode` offers OpenCode alone. |
| `system-defaults.json` | Not in `.env`: Qwen Code's defaults, in `/srv/workspace-portal/config/models`, with the model and its context of 262,144 tokens. It names no `max_tokens`, so Qwen Code asks for replies of 64,000 tokens and continues one that was cut off, and it sets `autoCompactThreshold` to 0.7, so Qwen Code compacts a conversation at 183,500 tokens and a whole reply always fits behind it. `sudo bash deploy/models.sh show` prints it and `install` replaces it; workspaces read it at their next start. |
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

### 11. HTTPS and remote access

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
> certificate logs. The AI server needs no remote access of its own: keep it on the LAN.

## Day to day

Both servers start everything by themselves at boot. **Admin > Usage** in the portal shows both servers and the LLM
sessions live, and **Admin > Users** the running workspaces; these are the commands for everything else.

| AI server | What it does |
|---|---|
| `curl -s http://127.0.0.1:8080/running \| jq -c '[.running[] \| {model, state}]'` | Which models run: the LLM, the image model or another media model, and at most one everyday speech or transcription model beside it. |
| `systemctl --user status llama-swap.service --no-pager` | State and uptime of llama-swap, which starts and stops the models. |
| `journalctl --user -u llama-swap -u gufo -f` | Live log of llama-swap and the LLM. |
| `journalctl --user -u ming -u gufo-video -u gufo-tts -u gufo-tts-clone -u gufo-tts-design -u gufo-asr -u vllm-sov -u fish-speech -u acestep -f` | Live log of the image and media models. |
| `curl -s http://127.0.0.1:18080/slots \| jq -c '[.[] \| .is_processing]'` | Which of the four sessions are busy, while the LLM runs. |
| `systemctl --user restart llama-swap.service` | Restart; the LLM loads again. Requests in progress are lost. |
| `grep . /sys/class/ec_su_axb35/apu/power_mode /sys/class/ec_su_axb35/temp1/temp /sys/class/ec_su_axb35/fan[12]/{rpm,duty}` | Power profile, controller temperature, fan speeds and duty. |
| `btop` `nvtop` | CPU, RAM and swap. GPU load and memory. |
| `systemctl status portal-hostd --no-pager` | portal-hostd, which feeds **Admin > Usage** and **Energy** and carries out the updates of Gufo and the other software. |

| Portal server in `~/workspace-portal` | What it does |
|---|---|
| `sudo docker compose ps` | State of the portal. |
| `sudo docker compose logs -f gateway web reader` | Live log. Every search and page read is a line of the gateway's. |
| `sudo docker compose logs searxng 2>&1 \| grep -E 'ERROR\|WARNING' \| grep -v botdetection \| tail -20` | What went wrong in the search engine: which engine failed, and why. |
| `sudo docker ps --filter label=workspace-portal.workspace=1 --format '{{.Names}} {{.Label "workspace-portal.agent"}} {{.Status}}'` | Running workspaces and their agents. |
| `sudo docker compose up -d` | Applies a change made in `.env`. Some settings need the installer instead: see [step 10](#settings). |
| `sudo bash deploy/verify-isolation.sh` | Tests the sandboxes, the search engine and the page reader again. Must end with `failed 0`. |
| `systemctl status workspace-portal-firewall --no-pager` | The firewall around the workspaces, the search engine and the page reader. Docker starts only once it is loaded. |
| `sudo systemctl reload workspace-portal-firewall` | Loads its rules again. Reload, never restart: a restart stops Docker and every workspace with it. |
| `sudo bash deploy/uninstall.sh` | Removes the portal: its containers, images, firewall and portal-hostd. Keeps `.env` and `/srv/workspace-portal`; with `--purge-data` it deletes that folder too. |

<details>
<summary>After a reboot of the AI server</summary>

**AI server**:

```sh
systemctl --failed --no-legend; systemctl --user --failed --no-legend
podman ps --format '{{.Names}} {{.Status}}'
systemctl --user is-active llama-swap
systemctl is-active m5-fans portal-hostd
cat /sys/class/ec_su_axb35/apu/power_mode
sudo ryzenadj --info | grep -E 'STAPM LIMIT|THM LIMIT'
cat /sys/class/watchdog/watchdog0/state
sudo firewall-cmd --zone=FedoraServer --list-rich-rules
```

**Good:** no failed units, `gufo Up ... (healthy)`, three services `active`, `performance`, the limits `132.000` and
`98.000`, the watchdog `active`, and two firewall rules naming the portal server, for ports 8080 and 9180.

</details>

<a id="engine-update"></a>

<details>
<summary>Updating the AI server</summary>

**After a kernel update**, `dkms status` must list `ec_su_axb35/m5-2` as installed for the new kernel, and the
speed check from [step 9](#9-test-it) should still show the same numbers. If the new kernel misbehaves, boot the
previous one:

**AI server**:

```sh
sudo grubby --info=ALL | grep -E '^(index|title)'
sudo grubby --set-default-index=1        # the index of the kernel that worked
sudo reboot
```

**A new Gufo release** is installed under **Admin > Updates > Gufo** in the portal, which lists the releases
with their notes and marks breaking changes. The new image downloads, running requests and a video being made finish
while new ones wait in the portal (up to 15 minutes, or **Restart now**), then Gufo restarts and must report the new version. If it
does not come up, the previous version is put back by itself, and the failed update ends with Gufo's own last log
lines: why it did not start. An update changes the image of every Gufo model: the LLM and, with the
[media models](#media-models), video, everyday speech and transcription. llama-swap stops them and starts the LLM,
and each other model starts with its next request. To go back to an older version later, pick it under **Package
images**. By hand: replace the image digest in every `~/.config/containers/systemd/gufo*.container` file, then
`systemctl --user daemon-reload` and `curl -X POST http://127.0.0.1:8080/api/models/unload`.

**llama-swap, vLLM and the media programs** have a card each under **Admin > Updates**, below Gufo's: the programs
of `llm-server/apps.json` that are installed. Each lists its releases (from GitHub, or for vLLM from its image
registry) with their notes, and what is installed. An update installs the new version beside the old one while
the old one serves (llama-swap is one download; a media program also builds its Python environment, which takes
longer), then waits for running requests like Gufo's, switches and restarts the program, and switches back
by itself if it doesn't come up. A program behind llama-swap is started once to check it, then the LLM loads
again; llama-swap's own restart stops every model. **Use…** switches to an installed version, **Remove…** deletes
one that is not in use. One update runs at a time on the AI server, Gufo's included.

> **vLLM** runs the transcription model with the model's own vLLM plugin, set up and tested with vLLM 0.32.0
> (`llm-server/vllm-sov.container`). An update checks only that the model starts and answers: read the release
> notes, and try a transcription after it.

**An install from before these cards** has llama-swap in `~/.local/bin`. Move it into the folder layout once; the
running llama-swap goes on serving until its next restart:

**AI server**:

```sh
cd ~/workspace-portal && git pull --ff-only
V=$(~/.local/bin/llama-swap --version | grep -o '[0-9]\+' | head -n 1)
mkdir -p ~/.local/lib/llama-swap
sh llm-server/apps/llama-swap/install.sh "$V" ~/.local/lib/llama-swap/"$V"
echo "$V" > ~/.local/lib/llama-swap/"$V"/.portal-version
ln -s "$V" ~/.local/lib/llama-swap/current
cp llm-server/llama-swap.service ~/.config/systemd/user/
systemctl --user daemon-reload
sudo bash hostd/install.sh llm --portal PORTAL_IP
```

**You should see** `install.sh: updates of other software: ...` among the installer's lines, and a llama-swap card
on **Admin > Updates**. Its first update restarts llama-swap from the new folder; after that,
`rm ~/.local/bin/llama-swap`.

</details>

<details>
<summary>Backups</summary>

The model can be downloaded again. What cannot, on the portal server: `~/workspace-portal/.env` and
`/srv/workspace-portal`, where `db/` holds the accounts, the API keys, the audit log, usage and energy, `users/`
every person's files and chat history, and `config/` the model settings and the agent versions. Copy it with
numeric owners and modes, because each workspace's files belong to a user ID of their own, and stop the portal
while `db/` is copied: `sudo docker compose down`, afterwards `sudo docker compose up -d`. On the AI server only
`~/.config/containers/systemd/*.container`, where **Admin > Updates** writes the versions of Gufo and vLLM, and
`~/.config/llama-swap/config.yaml`.

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

**You should see** `Workspace Portal is running.` within 3 minutes, or after the time of [step
10](#10-workspace-portal) when the update changes what every agent's image starts from, and `failed 0` about 6.5
minutes later. Running workspaces keep running, and an open browser tab carries on without a reload.

<details>
<summary>From a portal where a person's agents shared their two workspaces</summary>

Every agent now has its own Private and its own Online workspace for each person, with ports, user IDs and folders
numbered anew. A portal installed before that (its `.env` has a line `ONLINE_AGENT_PORT_BASE=`) is updated once
with the blocks below instead of the one above. People start with empty workspaces afterwards.

First stop every workspace under **Admin > Users**: the new gateway removes any that the old one started. Then
close the old ports, before the pull: the scripts of the old version know the ports it opened, and the new ones
would look for the new ports.

**Portal server**:

```sh
cd ~/workspace-portal && sudo bash -c 'source deploy/lib.sh && firewalld_rules remove'
```

**Portal server**, only if the portal is behind HTTPS ([step 11](#11-https-and-remote-access)):

```sh
cd ~/workspace-portal && sudo bash deploy/tailscale-https.sh off
```

**Portal server**:

```sh
cd ~/workspace-portal
git pull --ff-only
sed -i \
  -e 's|^AGENT_PORT_BASE=.*|AGENT_PORT_BASE=12000|' \
  -e 's|^AGENT_PORT_COUNT=.*|AGENT_PORT_COUNT=100|' \
  -e '/^ONLINE_AGENT_PORT_BASE=/d' -e '/^ONLINE_UID_BASE=/d' .env
sudo find /srv/workspace-portal/users -mindepth 2 -maxdepth 2 \( -name private -o -name online \) -exec rm -rf {} +
sudo bash deploy/install.sh
sudo bash deploy/verify-isolation.sh
```

**You should see** the installer's `Workspaces` line name ports 12020-13999, and `failed 0`. Behind HTTPS, run
`sudo bash deploy/tailscale-https.sh` again afterwards.

- **The `find` line deletes every person's old files and chats:** the folders `private` and `online` right under
  `users/NUMBER`, which no workspace uses any more and which fail the isolation check while they are there.
- **To keep a person's,** move them before that line into the workspace that is to have them, and give them to
  its user ID: 200000 (`WORKSPACE_UID_BASE`), plus 20 times the person's number, plus 0 for Qwen Code's Private
  workspace, 1 for its Online one, 2 and 3 for DeepSeek Harness's, 4 and 5 for OpenCode's. Here the old Private
  workspace of person 7 becomes their Qwen Code Private one:

  ```sh
  sudo sh -c 'cd /srv/workspace-portal/users/7 && install -d -m 711 qwen qwen/private \
    && mv private/home private/workspace qwen/private/ \
    && chown -R 200140:200140 qwen/private/home qwen/private/workspace'
  ```

- **`AGENT_PORT_COUNT=100`** gives the people numbered 1 to 99 their ports. A person's number ends the address of
  their page under **Admin > Users**: with one of 100 or more, set the count above the highest, 500 at most.
- **Pulled before closing the old ports?** `sudo tailscale serve reset` unmaps everything this machine serves
  through Tailscale, the old ports included. firewalld keeps its rules for them, where nothing listens any more:
  3101-3299, 3301-3499, 4101-4299 and 4301-4499 with the settings of this guide. `sudo firewall-cmd --permanent
  --list-rich-rules` shows them, and [step 3](#3-firewall)'s `--remove-rich-rule` takes one back. Then carry on
  with the last block.

</details>

<details>
<summary>What it keeps, and what it does not update</summary>

- **Kept:** `.env`, the model settings, the accounts, every person's files and chat history. The installer adds the
  settings your `.env` lacks and changes none. It refuses to run while an update from **Admin > Updates** is in
  progress or a video is being made.
- **The image models** moved from `IMAGE_MODELS` in `.env` to `media.json` ([step 10](#settings)). On an install
  from before, the installer writes that line's models into `media.json`, the first as the fast model and the second
  as the quality one (any others are dropped with a warning), and removes the line from `.env`. The [media
  models](#media-models) need their own step.
- **The image model** is Ming-Image-0.2-Design now, one model for drafts and final images, and it is set up with
  the [media models](#media-models). Gufo's Qwen-Image-2.1 and Turbo are gone. On an AI server set up before, run
  that step's lines for Ming-Image: its folders, its download, its build and `media/ming.service`. Then remove the
  old units and weights, which frees 65.6 GB, and load the new `llama-swap.yaml`:

  ```sh
  rm ~/.config/containers/systemd/gufo-image.container ~/.config/containers/systemd/gufo-image-turbo.container
  podman run --rm --user 0 -e GUFO_MODELS_DIR=/models -v /models/gufo-models:/models:z \
    "$(sed -n 's/^Image=//p' ~/workspace-portal/llm-server/gufo.container)" \
    sh -c 'gufo model remove qwen-image-2.1 && gufo model remove qwen-image-2.1-turbo'
  cp ~/workspace-portal/llm-server/llama-swap.yaml ~/.config/llama-swap/config.yaml
  systemctl --user daemon-reload
  systemctl --user restart llama-swap.service
  ```

  On the portal server, install `llm-server/media.json` again, as that step's **Portal server** block does.
- **Running workspaces** keep the image they started with and get the new one at their next start.
- **The agents** stay at their versions. **Admin > Updates** shows the current and the latest release of each
  enabled agent and updates it with one button. An update fails, and the current version stays, when the portal's
  changes do not fit the new version or it does not pass the portal's check; the failed update names what did not
  fit. From the shell: `sudo bash deploy/update-image.sh qwen VERSION`, with `dsh` for DeepSeek Harness and
  `opencode` for OpenCode.
- **A new agent** (OpenCode, for an install from before it) stays off, because the installer keeps
  `WORKSPACE_AGENTS` in your `.env`: add `opencode` to it, as in `WORKSPACE_AGENTS=qwen,dsh,opencode`, and run the
  installer again. It builds the agent's image: 4.2 to 4.9 GB, of which the agents' images share 3.7 GB.
- **portal-hostd on the AI server** updates separately: `cd ~/workspace-portal && git pull --ff-only && sudo bash
  hostd/install.sh llm --portal PORTAL_IP` there. It keeps its token and restarts only if something changed. It
  also installs the list of programs **Admin > Updates** updates there, and their install scripts.
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
| Gufo is stopped while loading | Loading took over 10 minutes, usually a slow disk. Raise `TimeoutStartSec` in `gufo.container` and `healthCheckTimeout` in `~/.config/llama-swap/config.yaml`. |
| An image takes minutes before it starts | llama-swap stops the LLM only once every running LLM request has ended, and agents' requests can run for minutes. `curl -s http://127.0.0.1:8080/running` shows what runs. |
| A unit fails with `wait-gpu-memory: ... GiB needed` | The model before it still held the memory after 60 seconds. `journalctl --user -u gufo`, or with the image or media unit's name (`ming` for images), says why; the next request of that model tries again. |
| Prompts wait, and the workspace says a video is being made | A video holds the AI server until it is downloaded. **Admin > Usage** shows how far it is; stopping the agent's turn cancels it. |
| A video made with curl on the AI server never finishes | A request for another model through llama-swap stopped H3, and the job with it. The portal holds such requests while its own video runs; a request sent to port 8080 directly does not wait. |
| Speech gets HTTP 500 | Qwen3-TTS takes a language by its full name, such as `english`, not `en`. Text whose prompt plus `max_new_tokens` does not fit its 8,192-token context fails too; the media tool sends long text in pieces. |
| A transcription of an M4A, AAC or WebM file fails | Qwen3-ASR reads WAV, FLAC, MP3 and Ogg. Convert the file first, as the media tool does: `ffmpeg -i in.m4a -ac 1 -ar 16000 out.flac`. |
| The AI server switched itself off or froze | On the next boot, `sudo journalctl -k -b \| grep 'reset reason'`. `hardware watchdog timer expired`: the kernel hung and the watchdog of [step 7](#7-fans-power-and-watchdog) rebooted it. `ACPI power state transition occurred`: the power went off without Linux, or someone switched it off. `software wrote 0x6`: an ordinary reboot. `sudo journalctl -b -1 -n 50` shows what it was doing, less its last seconds, which a hang loses. A CPU offset of -50 froze the test machine five times; step 7 sets -25. Delete `--set-coall=1048551` from `/etc/systemd/system/apu-tuning.service` and reboot to rule it out. [MEASUREMENTS.md](MEASUREMENTS.md#freezes) has what is known. |
| The model disappears under load | Read `journalctl --user -u gufo.service` and `sudo journalctl -k -b`. Exit status 75 is the stall timeout: nothing progressed for 10 minutes. An out-of-memory kill means something else is running on the AI server, or the layout is too big. |
| HTTP 429 from the model | More than 32 requests are waiting. Let the queue drain. |
| An agent thinks for minutes and stops without an answer | The reply ran out during the thinking. `gufo.container` must have its `--reasoning-budget` ([step 8](#8-start-the-models)), and `sudo bash deploy/models.sh show` must list an `autoCompactThreshold` and no `max_tokens`. |
| An agent never gets an answer | All four sessions are busy with long prompts, and a long prompt slows everyone who arrives after it. Look at `/slots` (see [Day to day](#day-to-day)). |
| The load test in step 9 says `FAIL` | A failed session says why on its own line; the line of readings shows whether all sessions ran at once, how much memory was left, and whether anything was swapped or killed. |
| The installer in step 7 says `refusing` or `Secure Boot is not off` | The first names what differs from the tested board and BIOS (AXB35-02, 3.11): the check is deliberate, stay on the firmware's fan control. For the second, switch Secure Boot off in the BIOS ([step 1](#1-install-fedora-server)) and run the installer again. |
| `/sys/class/ec_su_axb35` is missing | The driver is not loaded, usually because DKMS has not built it for a new kernel. `dkms status ec_su_axb35` must say `installed` for the running kernel; `sudo dkms autoinstall` builds it, and the fan service loads it within 10 seconds. |
| The installer in step 10 ends with `the stack did not become healthy` | One of the four containers did not come up. `sudo docker compose ps` names it and `sudo docker compose logs NAME` says why. Run the installer again afterwards. |
| Portal chat: `404 model ... is not served` | The model name in `system-defaults.json` must be `qwen3.8-flash-next`, the name Gufo serves. |
| An agent dies on its first tool call | `WORKSPACE_MEMORY` is too small. Qwen Code needs about 1.9 GB for a moment; use 2 GiB or more. |
| No **Preview** button, or a server listed as on localhost only | The button shows while a web server runs in the workspace, a few seconds after it starts. The server must listen on all addresses (`0.0.0.0`; Vite and Next.js need `--host 0.0.0.0` or `-H 0.0.0.0`). In a Private workspace the preview loads nothing from other sites, so an app that takes scripts or fonts from a CDN stays incomplete there. The preview shows one server of a workspace at a time: opening another switches its open tabs to that one. |
| Agents report no search results | The answer names the engines that did not answer. They sit out for 10 to 60 minutes and come back by themselves. |
| `read_page only opens pages you were shown` | The agent took the address from memory or made it up. Have it search first, paste the address into the chat, or change `READER_URL_POLICY` ([step 10](#settings)). |
| `read_page`: `The site refused the request` | That site turns automated readers away. The agent has to use another source. |
| `read_page`: `The page reader is busy` | It reads two pages at a time and the rest wait up to 30 seconds. The agent can ask again. |
| The portal cannot reach the model | From the portal server, `curl http://LLM_IP:8080/health` must answer `OK`. If not, the firewall rule in [step 8](#8-start-the-models) names the wrong address. |
| A program on the API gets `401` with `Incorrect API key` | The key was mistyped or revoked, or its account is disabled or still has a temporary password. The API page lists the working keys with their last four characters; create a new one there. |
| A program on the API gives up before an answer comes | Its request was waiting for a session, or the model was still reading a long prompt: nothing is sent in that time. **Admin > Usage** shows the busy sessions; give the program a longer timeout ([step 10](#the-api-for-your-own-software)). |
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
| Reading a prompt | **1,760-1,787 tok/s** | 32,000-token prompts, machine hot, fans at 80-95%, before the limits and fan curve of November 27 in [step 7](#7-fans-power-and-watchdog) |
| A 90,000-token prompt | about 55 s to the first word | One user |
| Four 256,000-token prompts at once | 10.6-10.7 min to the first word | The full-load test of step 9. Follow-up turns: 0.7-1.0 s |
| A turn in a long agent session | 0.6 s to the first word, 53 tok/s | Median of 278 agent requests; history served from cache |
| A new 122,000-token prompt on a full machine | 9-17 min to the first word | Measured with seven 128K sessions, all of them already reading 122,000-token prompts |
| Model load / restart | 16-17 s / healthy after 17-18 s | Four restarts. The load after a reboot took 17.4 s |
| After a reboot | Gufo answers after 32 s, the portal after 22 s | Counted from the start of the kernel; nothing to start by hand on either server |
| Raw photo, whole answer | 147 s (12 MP), 353 s (16.8 MP) | Idle server, image sent to the API at full size. Qwen Code shrinks images to 1,568 pixels on the long edge first, which is quick |
| Chip power | 121-128 W under load, about 7 W idle | The chip's own sensor, not a wall meter |
| Chip temperature under load | 97-98 °C average | The full-load test with the limits and fans of step 7: at the chip's 98 °C limit for 95% of it. Before them, with the Performance profile's limits and fans at 80-95%, 83-89 °C; 86-94 °C on firmware fans |
| Free memory, AI server | 9.6 GiB after load, 6.5 GiB with four full prompts at once | 4.7 GiB while four raw 12 MP photos were read. The full-load run moved 1 page to swap, the other tests none |
| Cancelling a reply | session free 0.5 s later | Three clients dropped mid-reply. With three sessions busy, a fourth request waited 5 s for its first word |

## Not tested

- A fresh install from USB and the BIOS screens. Both test machines kept their installed Fedora, so [step
  1](#1-install-fedora-server) was not run on them: its LVM commands for the AI server ran on a test disk image,
  the portal server's line not at all.
- [Step 6](#6-download-the-model) from an empty folder. Its blocks ran as written in a scratch folder that already
  held the three model files, the MTP helper and the vision file, so the download fetched the n-gram table and the
  script and only checked those five. The files were then moved into place.
- Most numbers with the 8.5-bit n-gram table. The full-load test and 20 of the 99 writing speeds are from it; the
  others were taken with Unsloth's 4.5-bit table or the full-precision one, which side by side read and write
  within 2% of it ([measurements](MEASUREMENTS.md#n-gram-table)).
- The older numbers on the current kernel. The reading speeds on the fan curve, the image timings and the
  full-machine run date from kernel 7.2.15 and were not repeated with 7.3.4.
- Fedora 45 on the AI server, and a Fedora release upgrade on either server.
- Coming back after a real power cut.
- A Gufo update that fails to start, and **Restart now**, in the last test. An earlier forced bad update put the
  previous version back by itself.
- More than the 9 hours of continuous load tests the model has served without a restart.
- DeepSeek Harness under load. The stress runs used Qwen Code.
- OpenCode's own page under load. Since November 24, 2026 OpenCode is the portal server's only agent. In a
  headless browser a person signed in, started a Private workspace in one click, opened one and three web
  servers with the Preview button and stopped the workspace, also at the widths of a tablet and a phone. The
  [load test](MEASUREMENTS.md#opencode) sent its 51 turns through OpenCode's API with that page closed, in
  Private workspaces only. Also not tried with OpenCode: more than three workspaces at once, images, a
  conversation shortened more than once, and a reply cut off at the real limit of 64,000 tokens (it was forced
  at 1,500).
- All three agents since the workspace image holds the toolchains. The times and the count of [step
  10](#10-workspace-portal) are the portal server's with OpenCode alone; with three agents, before that image, the
  isolation check made 492 checks in 12 minutes. The images of Qwen Code and DeepSeek Harness were built on the
  portal server and removed again; on a development machine each was started as a workspace runs and answered the
  gateway's readiness check, with a stand-in for the model at most and without a browser.
- A workspace of its own for every agent, with Qwen Code or DeepSeek Harness in a browser. The portal server got
  that layout on November 24, 2026, with every person's files deleted: the half minute of [step
  11](#11-https-and-remote-access) is from that run, with three agents (9 seconds with one), and a workspace of each
  agent was started, stopped and erased through the gateway. Not run: those two agents' pages in a browser on the
  new ports, `tailscale-https.sh off` on them, and the update from the old layout as [Update the
  portal](#update-the-portal) writes it (the server's old ports were closed with `tailscale serve reset`, and
  nobody's files were moved).
- The page reader under many agents at once. It was tested with one agent of each kind and with six pages at a
  time.
- [Step 11](#11-https-and-remote-access) from its first line. Tailscale was already installed and signed in, so
  only `tailscale-https.sh` ran, on and off. Over HTTPS the portal, both kinds of workspace, Qwen Code, DeepSeek
  Harness and a web preview were then used from a PC of the same tailnet, on the server's LAN and from another
  network.
- The [API](#the-api-for-your-own-software) at the portal's LAN address, and an editor on it. The test portal
  answers over HTTPS only ([step 11](#11-https-and-remote-access)). There curl, the OpenAI libraries for Python
  (3.55.1) and Node (7.60.0) and Anthropic's for Python (2.10.0) used it with a key, and 56 of 61 different
  requests got the same answer as from Gufo itself; the other five differ in a redirect for a trailing slash, a
  timestamp, the case of header names and a WebSocket request, which is closed.
- Installing the portal as an app on a real phone, and a screen reader. Chrome's own install check passed with an
  emulated Pixel 7; no iPhone was at hand.
- A kernel update on the AI server with this fan driver. DKMS has built it for the running kernel only.
- [Media models](#media-models) as written. The test machine got the same models at the same revisions, the same
  programs and units, piece by piece; the blocks here are put together from what it recorded, and their checks
  send the requests its measurements sent. Swaps to and from each media model were not timed.
- [LTX-2.5](#ltx-25). Its program is built on the test machine, but its weights were never downloaded: nothing of it
  has run.
- Fan noise and power at the wall. No meters were at hand.

## Versions and sources

| Part | Version on the test machines |
|---|---|
| AI server | Ryzen AI Max+ 395, 128 GB, board AXB35-02, BIOS 3.11 (May 8, 2026); Fedora 44 Server, kernel 7.3.4-200.fc44, Mesa 26.2.6, Podman 5.8.9, crun 1.30 |
| Engine | [Gufo 0.37.0](https://github.com/gufo-org/gufo/releases/tag/v0.37.0) (build 684b716), image digest `sha256:9548e994...5bb1d4dc` |
| Model router | [llama-swap v277](https://github.com/mostlygeek/llama-swap/releases/tag/v277) (1112737) |
| Model | [Qwen3.8-Flash-Next](https://huggingface.co/Qwen/Qwen3.8-Flash-Next), [UD-Q4_K_XL from Unsloth](https://huggingface.co/unsloth/Qwen3.8-Flash-Next-GGUF/tree/f5d175de2cf7f720d45d6064019a81fcf056e986) with the Q8_0 n-gram table, shared Q8 MTP, BF16 vision projector; downloaded with huggingface_hub 2.4.0 and hf-xet 1.8.0 |
| Image model | [Ming-Image-0.2-Design](https://huggingface.co/inclusionAI/Ming-Image-0.2-Design/tree/3538f4c311cf8f5256d631ddb7f47793f741aa2e) (3538f4c), BF16; MIT |
| Media models | [MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3/tree/42ed227ee7df40d41602854ae760620d6eb651fe) (42ed227), Qwen3-TTS-12Hz-1.7B [Base](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base/tree/fd4b254389122332181a7c3db7f27e918eec64e3) (fd4b254), [CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice/tree/0c0e3051f131929182e2c023b9537f8b1c68adfe) (0c0e305) and [VoiceDesign](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/tree/5ecdb67327fd37bb2e042aab12ff7391903235d3) (5ecdb67), [Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B/tree/7278e1e70fe206f11671096ffdd38061171dd6e5) (7278e1e), [Fish Audio S2-Pro](https://huggingface.co/fishaudio/s2-pro/tree/1de9996b6be38b745688de084d87a5633f714e4e) (1de9996), [ACE-Step 1.5](https://huggingface.co/ACE-Step/Ace-Step1.5/tree/19671f406d603126926c1b7e2adc169acbcade22) (19671f4) with [XL base](https://huggingface.co/ACE-Step/acestep-v15-xl-base/tree/220c1166efbdd9583eafcb12eb160594bbfcb241) (220c116) and [XL turbo](https://huggingface.co/ACE-Step/acestep-v15-xl-turbo/tree/d4a0b288b83ebb7e25a8c0b32c573c22e134e8ee) (d4a0b28), [SOV-Transcribe-1](https://huggingface.co/salesforce-sovereign-intelligence/SOV-Transcribe-1/tree/505d8fae243924c0d8acdc622f7f0abab344eba3) (505d8fa) with [its DFlash draft](https://huggingface.co/salesforce-sovereign-intelligence/SOV-Transcribe-1-DFlash/tree/8c0b3f3a98507d2e3dd35b1bee0f147fa3bded05) (8c0b3f3); [LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5/tree/69ecadd4932572caf956135d41cbcdbd697aa442) (69ecadd) not downloaded |
| Media programs | [Ming-Image](https://github.com/inclusionAI/Ming-Image/tree/d5615110e3ae7d27f270eafe5556d669b2069971) (d561511) on AMD's PyTorch 2.14.0 for ROCm 10.2.0, [fish-speech](https://github.com/fishaudio/fish-speech/tree/v3.0.0-beta) 3.0.0-beta, [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5) 0.1.8, [LTX-2](https://github.com/Lightricks/LTX-2/tree/v1.6.3) 1.6.3 (built, not run), vLLM 0.32.0 in [kyuz0's image](https://github.com/kyuz0/amd-strix-halo-vllm-toolboxes) `rocm10.0.0-torch2.11.0-vllm0.32.0`; uv 0.13.7, ffmpeg-free 8.1.3 |
| Fan driver | `llm-server/fans/ec_su_axb35.c` in the repository, version m5-2: reduced from [cmetz/ec-su_axb35-linux](https://github.com/cmetz/ec-su_axb35-linux/tree/f62c2c228959a08683273a26ef3afd8991e69f6d) at f62c2c2, duty registers after [FanControl.AXB35](https://github.com/crmaris/FanControl.AXB35) |
| APU tuning | [RyzenAdj](https://github.com/FlyGoat/RyzenAdj) 0.18.0 (527cacc) from [COPR shdwchn10/ryzenadj](https://copr.fedorainfracloud.org/coprs/shdwchn10/ryzenadj/), with its `ryzen_smu` driver (d298366) |
| Portal server | Pentium G4400T (2 cores), 8 GB; Fedora 45 Server, kernel 7.3.4-300.fc45, moby-engine 29.9.3, Tailscale 1.102.5 |
| Portal | [Workspace Portal](https://github.com/ShahriarDhruvo/workspace-portal), [Qwen Code](https://github.com/QwenLM/qwen-code) 0.28.0 (a fresh install builds 0.27.0; updated under **Admin > Updates**), DeepSeek Harness 0.2.2-rc.1, OpenCode 2.4.1 (the only agent enabled on the test server since November 24, 2026), [SearXNG](https://github.com/searxng/searxng) 2026.11.12. Page reader: [Defuddle](https://github.com/kepano/defuddle) 0.19.6, pypdfium2 5.15.2 |

Further reading: [Gufo server options](https://github.com/gufo-org/gufo/blob/v0.37.0/docs/server.md) · [llama-swap
configuration](https://github.com/mostlygeek/llama-swap/blob/v277/docs/config.example.yaml) · [amdgpu
kernel parameters](https://docs.kernel.org/gpu/amdgpu/module-parameters.html) · [kyuz0's Strix Halo
toolboxes](https://github.com/kyuz0/amd-strix-halo-toolboxes) · [strixhalo.wiki](https://strixhalo.wiki/) ·
[Hardware Busters on the test machine's fans](https://hwbusters.com/?p=116224) · [Tailscale on
Linux](https://tailscale.com/docs/install/linux)

*Strix Halo local agent server, November 20, 2026. Results come from one unit and will differ a little on yours.*
