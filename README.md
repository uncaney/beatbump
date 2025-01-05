
# Beatbump

This project is a continuation of Beatbump by @snuffyDev.

An alternative frontend for YouTube Music created using Svelte/SvelteKit, and Golang.

<p align="center">
	  <a href="https://www.gnu.org/licenses/agpl-3.0.en.html">
    <img alt="License: AGPLv3" src="https://shields.io/badge/License-AGPL%20v3-blue.svg">
  </a>
  <a href="https://github.com/humanetech-community/awesome-humane-tech">
    <img alt="Awesome Humane Tech" src="https://raw.githubusercontent.com/humanetech-community/awesome-humane-tech/main/humane-tech-badge.svg?sanitize=true">
  </a>
</p>

### Important note
As of Nov 2024 Google has started [blocking datacenter ips](https://github.com/yt-dlp/yt-dlp/issues/10128).
Overcoming the ip block, requires issuing an authenticated request, this can be achieved in one of 2 ways -
- Oatuh
- Cookie authentication

Note that Google is keep cracking down on these methods (cookies and oauth),
so this will be a cat and mouse game (see [here](https://github.com/yt-dlp/yt-dlp/issues/11462) and [here](https://github.com/yt-dlp/yt-dlp/issues/11868))

If you are running beatbump on a datacenter, and experiencing errors (songs not playing), please follow the instructions below on 
configuring oauth/cookies

## Features

- Automix for continued listening
- No ads
- Background play on mobile devices
- Search for artists, playlists, songs, and albums
  - Note that all playback is audio only (for now)
- Local playlist management
  - Stored in-browser with IndexedDB
  - Can save songs individually under 'Favorites'
  - Peer-to-Peer data synchronization (using WebRTC)
- Group Sessions
  - Achieved with WebRTC in a [mesh](https://en.wikipedia.org/wiki/Mesh_networking)
- Uses a custom wrapper around the YouTube Music API

...and so much more!


## Privacy

All data is stored locally on your device. Data synchronization is done using PeerJS, which uses WebRTC for a
Peer-to-Peer connection between browsers.

### Contributing

Contributions are welcomed

### Running Beatbump locally

- git clone https://github.com/giwty/Beatbump.git
- docker build . -t beatbump
- docker run 8080:8080 beatbump
- Access http://app.localhost:8080

### Deploying Beatbump to public clour
... easiest way to deploy beatbump is to use Google's cloud run, which allows to deploy a docker.
More details will provided latter

### Important - additional configuration needed
If songs do not play, that means your ip is blocked and requires authenticated session.
Follow one of the options below, you advised to not use your main Google account, but create a dedicate one for this purpose.

#### Option 1 - oauth authentication
- Follow the insturctions [here](https://developers.google.com/youtube/registering_an_application) to register application.
For your new credentials, select OAuth client ID and pick TVs and Limited Input devices.
- Obtain the client id and client secret and paste in Beatbump settings
- Click the "Start Oauth flow" and follow the steps in the new tab
- Once complete, go back to Beatbump and click on the complete button.
- If all went well, a new Cookie will be saved with your Oauth access token.
- Try to play some music and see if it works now!

#### Option 2 - cookie authentication
To run authenticated requests, set it up by first copying your request headers from an authenticated POST request in your browser.
To do so, follow these steps:

- Open a new tab in your favorite browser
- Open the developer tools (Ctrl-Shift-I) and select the "Network" tab
- Go to https://music.youtube.com and ensure you are logged in (Dont use your main Google account)
- Find an authenticated POST request. The simplest way is to filter by ``/browse`` using the search bar of the developer tools.
  If you don't see the request, try scrolling down a bit or clicking on the library button in the top bar.
- Verify that the request looks like this: **Status** 200, **Name** ``browse?...``
- Find the section called 'Request Headers'
  Find the item named 'Cookie' and copy the value. It is VERY important that you copy the exact value. Double check that you do not include any additional spaces or characters at the start/end of the value Cookie value
- Some browser will have an option to copy the value by right clicking and selecting "Copy Value"
- Paste the value into Beatbump Cookie header setting.
- Try to play some music and see if it works now!

Note :Cookies will expire after some time. This means that you will have to run this process again if Beatbump stops working. 


### Project Inspirations

- [Invidious](https://github.com/iv-org/invidious) - a privacy focused alternative YouTube front end.
