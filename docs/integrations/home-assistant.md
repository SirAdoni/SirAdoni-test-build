# Home Assistant Integration

This guide shows you how to connect Marinara Engine to Home Assistant. Once connected, your AI characters can control real smart home devices right from a chat. They can work lights, climate, covers, and media players. The connection also lets Home Assistant automations send messages into Marinara.

Home Assistant is a free, open source platform for controlling smart home devices. If you do not run Home Assistant, you do not need this integration.

## What this integration does

The integration is a small piece of software that installs inside Home Assistant. It links a running Home Assistant to a running Marinara Engine server. Once installed, it does three things for you automatically:

- It creates smart home tools inside Marinara. These appear in the **Functions** section of the Presets panel. Marinara calls these "custom tools" or "Functions". See [Custom Tools](../extending/custom-tools.md) for how Functions work in general.
- It creates one AI agent inside Marinara named **Home Assistant**. An agent is an AI helper that runs alongside your chat. See [Agents Overview](../agents/agents-overview.md).
- It creates several Home Assistant entities so you can watch and control Marinara from the Home Assistant side. An entity is a device, sensor, or control in Home Assistant.

You never copy tool addresses or set up tools by hand. The integration wires everything together on first setup.

## Prerequisites

Before you start, make sure you have all of the following.

- A running Home Assistant, version 2024.1.0 or newer.
- HACS installed in Home Assistant. HACS is the Home Assistant Community Store, a tool for installing custom integrations that are not built in.
- Marinara Engine installed and running, and reachable from your Home Assistant machine. The default address is `localhost:7860`. If Home Assistant runs on a different device, read the note below about passwords.
- The setting `WEBHOOK_LOCAL_URLS_ENABLED=true` added to Marinara's `.env` file.

The `.env` file is the plain text settings file for the Marinara server. See [Server Configuration](../CONFIGURATION.md) to learn where it is and how to edit it.

You need that last setting because the integration uses a webhook. A webhook is a web address that lets one app send data to another automatically. Home Assistant's webhook address is a local, plain `http` address. Marinara blocks calls to local `http` addresses by default for safety. Setting `WEBHOOK_LOCAL_URLS_ENABLED=true` allows them.

Add this line to your `.env` file:

```
WEBHOOK_LOCAL_URLS_ENABLED=true
```

This setting takes effect within a couple of seconds. You do not need to restart the Marinara server.

### If Home Assistant runs on a different device

The integration connects to Marinara without a username or password. There is no place to enter one in the setup form. Because of this, where Home Assistant runs matters:

- If Home Assistant and Marinara run on the same machine, the connection works out of the box.
- If Home Assistant runs on a different device, Marinara blocks the connection by default. You must allow the Home Assistant device to connect without a password. One way is to add that device's IP address to `IP_ALLOWLIST` in Marinara's `.env` file. An IP address is the number address of a device on your network. On a fully trusted home network, you can set `ALLOW_UNAUTHENTICATED_PRIVATE_NETWORK=true` instead.
- If Marinara is protected with `BASIC_AUTH_USER` and `BASIC_AUTH_PASS`, the integration cannot log in. It then only works from the same machine, or from a device listed in `IP_ALLOWLIST`.

See [Remote Access](../REMOTE_ACCESS.md) for how these settings work and which one to pick.

## Install the integration in Home Assistant

You install the integration in two stages. First you add it to HACS, then you set it up.

### Add it to HACS

1. In Home Assistant, open **HACS**.
2. Open the three-dot menu, then click **Custom repositories**.
3. In the repository box, enter this address:

```
https://github.com/Pasta-Devs/Marinara-Engine
```

4. Set the category to **Integration**, then click **Add**.
5. Search for **Marinara Engine**, then install it.
6. Restart Home Assistant.

### Set it up

1. Go to **Settings**, then **Devices & Services**, then click **Add Integration**.
2. Search for **Marinara Engine**.
3. Enter the **Host** and **Port** where Marinara is running. The defaults are `localhost` and `7860`.
4. Click **Submit**.

If Marinara cannot be reached at that address, Home Assistant shows an error and does not finish. See Troubleshooting below.

## What Marinara Engine creates automatically

When setup succeeds, the integration builds everything for you.

- It registers a private webhook inside Home Assistant.
- It creates the smart home tools in Marinara's **Functions** section, each already pointed at that webhook.
- It creates the **Home Assistant** agent in Marinara, listing every enabled tool.
- It creates the Home Assistant entities described later in this guide.

## Add the Home Assistant agent to a chat

Creating the agent does not attach it to every chat. You must add it to each chat where you want smart home control.

1. Open the chat you want.
2. Open **Chat Settings**, then the **Agents** section.
3. Add the **Home Assistant** agent to the chat.

The Home Assistant agent runs in Roleplay, Conversation, and Game chats. Once it is added, the smart home tools become available to the AI in that chat automatically. You do not need to turn anything else on in the chat.

## Verify the setup works

Test the connection with one simple request.

1. Add the **Home Assistant** agent to a chat, as shown above.
2. In that chat, type a plain request, for example: `Turn on the office lights`.
3. Send the message.

The AI should call a smart home tool, such as `ha_turn_on`, and the matching lights should turn on. The AI then confirms what it did. If nothing happens, check that `WEBHOOK_LOCAL_URLS_ENABLED=true` is set, and see Troubleshooting.

## Exposed tool categories

The integration groups its smart home tools into eight categories. You choose which categories Marinara may use.

To change the categories, open **Settings**, then **Devices & Services**, click **Marinara Engine**, then click **Configure**. You will see two options:

- **Primary Chat**: the default chat that the Home Assistant services target. Those services are described later in this guide.
- **Exposed Tool Categories**: the list of tool categories Marinara is allowed to use.

This table lists each category, its default state, and the tools it contains.

| Category | Default | Tools |
|---|---|---|
| Lights & Switches | On | ha_turn_on, ha_turn_off, ha_toggle, ha_set_brightness, ha_set_color, ha_set_color_temp |
| Climate | On | ha_set_temperature, ha_set_hvac_mode |
| Covers (Blinds & Garage) | On | ha_open_cover, ha_close_cover, ha_set_cover_position |
| Locks | Off | ha_lock, ha_unlock |
| Media Players | On | ha_media_play, ha_media_pause, ha_set_volume |
| Scenes & Scripts | On | ha_activate_scene, ha_run_script |
| Query | On | ha_get_state, ha_list_areas, ha_list_entities, ha_notify |
| Generic Service Calls (Advanced) | Off | ha_call_service |

Both **Locks** and **Generic Service Calls (Advanced)** are off by default. Turn them on only if you want them. **Generic Service Calls (Advanced)** lets the AI call any Home Assistant service, so treat it with care.

Most tools accept either one specific device or a room name. If you give a room name, the tool acts on every matching device in that room at once.

Changes to the categories only take effect after you press **Marinara Sync HA Tools** or restart Home Assistant. That button is described in the next section.

## Home Assistant entities

The integration creates these entities under a Home Assistant device named **Marinara Engine**.

| Entity | Type | What it does |
|---|---|---|
| Marinara Chat Count | Sensor | Shows the total number of Marinara chats |
| Marinara Active Agent Count | Sensor | Shows how many Marinara agents are enabled |
| Marinara Active Chat | Select | Picks which chat the Home Assistant services target |
| Marinara Agent: (name) | Switch | Turns one Marinara agent on or off. There is one switch per agent |
| Marinara Abort Generation | Button | Cancels any AI response that is being generated |
| Marinara Sync HA Tools | Button | Re-sends all tools and rebuilds the Home Assistant agent |

The integration checks Marinara for new chats and agents every 30 seconds. A chat or agent you just made in Marinara may take up to 30 seconds to show up here.

## Control Marinara from Home Assistant automations

The integration adds two Home Assistant services. You use these inside Home Assistant automations, not inside Marinara. Both can target your **Primary Chat** by default.

### Send Message (marinara_engine.send_message)

This sends a message into a Marinara chat.

- `message`: the message text. This field is required.
- `chat_id`: which chat to send to. If you leave it blank, the Primary Chat is used.
- `role`: who the message is from. It can be `user`, `assistant`, `system`, or `narrator`. The default is `user`.
- `trigger_generation`: when true, the AI also replies after the message is sent. The default is false.

Here is an automation that tells the AI when the front door opens:

```yaml
automation:
  trigger:
    platform: state
    entity_id: binary_sensor.front_door
    to: "on"
  action:
    service: marinara_engine.send_message
    data:
      message: "Someone just arrived at the front door."
      trigger_generation: true
```

### Trigger Generation (marinara_engine.trigger_generation)

This starts an AI reply in a chat without you sending a visible message.

- `chat_id`: which chat to use. If you leave it blank, the Primary Chat is used.
- `user_message`: an optional message to include with the reply turn.

## Re-syncing after you change settings

When you change the enabled categories, press **Marinara Sync HA Tools** to apply the change. You can find this button on the **Marinara Engine** device page in Home Assistant.

Pressing **Marinara Sync HA Tools** does the following:

- It updates the existing tools in place, so any changes reach Marinara.
- It rebuilds the **Home Assistant** agent if you deleted it in Marinara.
- It disables any tool whose category you turned off. It does not delete those tools.

Do not hand-edit the Home Assistant tools inside Marinara. The next sync overwrites your edits and turns the tools back on.

## Troubleshooting

### The setup form says it cannot connect

Make sure Marinara Engine is running. Check that the **Host** and **Port** you entered match where it is listening. The default is `localhost` and `7860`.

If Home Assistant runs on a different device than Marinara, Marinara blocks it by default. The integration cannot send a password, so Marinara must accept that device without one. Add the Home Assistant device's IP address to `IP_ALLOWLIST` in Marinara's `.env` file. See [Remote Access](../REMOTE_ACCESS.md) for this and other options. A Marinara protected with `BASIC_AUTH_USER` and `BASIC_AUTH_PASS` also rejects the integration, unless the device is listed in `IP_ALLOWLIST`.

These rules still apply after setup. If Marinara later blocks the Home Assistant device, the sensors and the chat list quietly stop updating.

### The AI tries a device tool but nothing happens

The webhook call is most likely blocked. Add `WEBHOOK_LOCAL_URLS_ENABLED=true` to Marinara's `.env` file and save it. This takes effect within a couple of seconds. Without it, tool calls can fail with a message about `http` not being allowed, or about a private address being refused.

If Marinara and Home Assistant run on the same machine, the integration uses the internal address for the webhook automatically. If Marinara runs on a different device, make sure Home Assistant's local network address is reachable from that device.

### The tools do not appear in the Functions list

Press **Marinara Sync HA Tools**, or restart Home Assistant. Then check the **Functions** section of the Presets panel in Marinara.

### The Home Assistant agent is not in my chat

First confirm the **Home Assistant** agent exists in Marinara under Agents. If it is missing, press **Marinara Sync HA Tools** to rebuild it. Then open **Chat Settings**, open the **Agents** section, and add the **Home Assistant** agent to that chat.

### Finding the webhook address by hand

You rarely need this, since each tool already has the address set. To find it, open **Settings**, then **Devices & Services**, then **Marinara Engine** in Home Assistant. The webhook uses this pattern, where 8123 is the default Home Assistant port:

```
http://<homeassistant-ip>:8123/api/webhook/<webhook-id>
```

## Uninstalling

To remove the integration, delete it from **Settings**, then **Devices & Services**, then **Marinara Engine** in Home Assistant. This removes the Home Assistant entities. The tools it created in Marinara's **Functions** section stay in Marinara. So does the **Home Assistant** agent. Delete both by hand in Marinara if you no longer want them.

## Related guides

- [Custom Tools](../extending/custom-tools.md)
- [Agents Overview](../agents/agents-overview.md)
- [Server Configuration](../CONFIGURATION.md)
- [Remote Access](../REMOTE_ACCESS.md)
