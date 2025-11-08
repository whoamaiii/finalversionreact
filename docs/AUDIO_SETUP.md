# BlackHole Audio Routing Setup

This guide walks through configuring reliable system-audio routing for VJ shows across macOS, Windows, and Linux. Follow the steps to install a virtual audio device, create a loopback path, and verify the signal before launching the app. Each step references a screenshot placeholder—replace these with actual captures when documenting your environment.

## macOS · BlackHole 2ch

1. **Download the installer** – Visit [existential.audio/blackhole](https://existential.audio/blackhole/) and request the BlackHole 2ch download. Check your email for the DMG link.
   ![Request BlackHole download](./images/audio-setup/macos-blackhole-download.png "Screenshot: BlackHole download request page")
2. **Install BlackHole** – Open the DMG and run the installer. Accept the security prompts when macOS asks for confirmation.
   ![Install BlackHole package](./images/audio-setup/macos-blackhole-installer.png "Screenshot: macOS installer dialog")
3. **Create a Multi-Output Device** – Launch `Audio MIDI Setup`, click the `+` button in the bottom-left corner, and choose `Create Multi-Output Device`.
   ![Create Multi-Output device](./images/audio-setup/macos-audio-midi-create-multi-output.png "Screenshot: Audio MIDI Setup create device")
4. **Add devices to the mix** – Check both `BlackHole 2ch` and your physical speakers (e.g., `MacBook Pro Speakers`) in the right panel. Enable `Drift Correction` on the physical output to keep the clocks aligned.
   ![Enable BlackHole and speakers](./images/audio-setup/macos-audio-midi-enable-blackhole.png "Screenshot: Multi-output configuration")
5. **Set system default output** – Right-click the new Multi-Output Device and choose `Use This Device For Sound Output`. Confirm the device icon turns into a speaker.
   ![Set default output](./images/audio-setup/macos-audio-midi-set-default.png "Screenshot: Set default output device")
6. **Verify signal flow** – Play music in any app. You should hear it via speakers while the level meter for BlackHole moves. If levels stay flat, re-open the Audio MIDI Setup utility and confirm the boxes remain checked.
   ![Verify audio meters](./images/audio-setup/macos-audio-midi-meters.png "Screenshot: Meter activity in Audio MIDI Setup")

## Windows · VB-Cable

1. **Download VB-Cable** – Go to [vb-audio.com/Cable](https://vb-audio.com/Cable/) and download the ZIP (`VBCABLE_Driver_PackXX.zip`).
   ![Download VB-Cable](./images/audio-setup/windows-vbcable-download.png "Screenshot: VB-Cable download page")
2. **Install as administrator** – Extract the ZIP, right-click `VBCABLE_Setup_x64.exe`, and choose `Run as administrator`. Approve any security prompts.
   ![Run VB-Cable installer](./images/audio-setup/windows-vbcable-installer.png "Screenshot: User Account Control prompt")
3. **Reboot Windows** – Restart the machine so Windows registers the new virtual device. Skipping this step often prevents the device from appearing.
   ![Windows restart reminder](./images/audio-setup/windows-restart.png "Screenshot: Windows restart dialog")
4. **Configure playback device** – Open `Sound settings → More sound settings`. In the `Playback` tab, set `CABLE Input (VB-Audio Virtual Cable)` as the default device. In the `Recording` tab, keep `CABLE Output` enabled for routing into the app.
   ![Configure VB-Cable defaults](./images/audio-setup/windows-sound-control-panel.png "Screenshot: Sound Control Panel with VB-Cable")
5. **Optional: Create multi-output** – If you need to monitor while routing, enable `Listen to this device` on your physical speakers and route CABLE Input to them. Alternatively, use VB-Audio VoiceMeeter for more advanced mixing.
   ![Enable Listen to this device](./images/audio-setup/windows-listen-to-device.png "Screenshot: Listen to device settings")
6. **Verify signal** – Play audio and watch for signal on the `Recording → CABLE Output` meters. If silent, re-open the Sound panel and ensure VB-Cable remains the default playback device.
   ![Verify VB-Cable meters](./images/audio-setup/windows-vbcable-levels.png "Screenshot: Recording meters showing signal")

## Linux · PulseAudio Virtual Sink

1. **Install required tools** – Ensure `pavucontrol` and the PulseAudio utilities are installed (`sudo apt install pavucontrol pulseaudio-utils`).
   ![Install PulseAudio tools](./images/audio-setup/linux-install-packages.png "Screenshot: Terminal installing PulseAudio packages")
2. **Create a null sink** – Run `pactl load-module module-null-sink sink_name=ShowLoopback sink_properties=device.description=ShowLoopback`. This makes a virtual output named `ShowLoopback`.
   ![Create null sink](./images/audio-setup/linux-create-null-sink.png "Screenshot: Terminal running pactl load-module")
3. **Monitor the sink** – Execute `pactl load-module module-loopback source=ShowLoopback.monitor`. This routes the virtual sink back as a capture source.
   ![Link monitor source](./images/audio-setup/linux-loopback.png "Screenshot: Terminal enabling loopback")
4. **Set default output** – Open `pavucontrol → Playback` and set apps (e.g., browser, player) to output to `ShowLoopback`. Under `Output Devices`, mark it as the fallback.
   ![Set fallback output](./images/audio-setup/linux-pavucontrol-output.png "Screenshot: pavucontrol fallback output selection")
5. **Monitor audio** – In `pavucontrol → Recording`, confirm that `ShowLoopback.monitor` appears and shows audio levels. Route monitoring to speakers by changing the loopback target if needed.
   ![Verify monitor levels](./images/audio-setup/linux-pavucontrol-recording.png "Screenshot: pavucontrol recording meters")
6. **Persist across sessions (optional)** – Add the `load-module` commands to `~/.config/pulse/default.pa` or systemd user services so the virtual sink auto-loads on boot.
   ![Persist module](./images/audio-setup/linux-default-pa.png "Screenshot: Editing default.pa in editor")

## Troubleshooting

- **Virtual device missing after reboot** – On macOS, reopen `Audio MIDI Setup` and ensure the Multi-Output Device still lists BlackHole. On Windows, confirm VB-Cable remains the default playback device. On Linux, verify the PulseAudio modules auto-load (reload them manually if not).
- **No audio levels in the app** – Confirm the browser tab or player is routed to the virtual device. Check the meters in Audio MIDI Setup, Sound Control Panel, or pavucontrol.
- **Device labels hidden in browser** – Browsers hide device names until microphone permissions are granted. Start microphone capture once so labels populate, then refresh.
- **Heard audio but app silent** – Ensure the virtual sink or Multi-Output includes your physical speakers. If you only route to BlackHole/VB-Cable without monitoring, you will lose local playback.
- **Latency feels off** – Use the app’s latency compensation controls to fine-tune. Virtual devices add ~10–30 ms depending on the OS.
- **Crackles or drift** – Enable `Drift Correction` (macOS) or reduce buffer sizes in the app’s audio settings. On Linux, experiment with JACK or PipeWire if PulseAudio crackles under load.
- **Reverting to defaults** – macOS: set `MacBook Pro Speakers` directly as output to bypass BlackHole. Windows: pick your speakers as default playback. Linux: unload modules with `pactl unload-module <id>`.

Refer back to this guide whenever you add new hardware or reinstall the OS to make sure the virtual routing stays locked in.




