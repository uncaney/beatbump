
# Beatbump

This project is a continuation of [Beatbump by @snuffyDev](https://github.com/snuffyDev/Beatbump).

An alternative frontend for YouTube Music created using Svelte/SvelteKit, and Golang.

<p align="center">
	  <a href="https://www.gnu.org/licenses/agpl-3.0.en.html">
    <img alt="License: AGPLv3" src="https://shields.io/badge/License-AGPL%20v3-blue.svg">
  </a>
  <a href="https://github.com/humanetech-community/awesome-humane-tech">
    <img alt="Awesome Humane Tech" src="https://raw.githubusercontent.com/humanetech-community/awesome-humane-tech/main/humane-tech-badge.svg?sanitize=true">
  </a>
</p>

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
- Download songs for offline listening \
...and so much more!


## Privacy

All data is stored locally on your device. Data synchronization is done using PeerJS, which uses WebRTC for a
Peer-to-Peer connection between browsers.

## Contributing

Contributions are welcomed

## Running Beatbump

### Run directly from source code
- git clone https://github.com/giwty/Beatbump.git
- docker build . -t beatbump:latest
- docker run -p 8080:8080 beatbump:latest
- Access http://app.localhost:8080

### Running via prebuilt docker image
- docker pull ghcr.io/giwty/beatbump:latest
- docker run -p 8080:8080 ghcr.io/giwty/beatbump:latest
- Access http://app.localhost:8080

You can add [-dit] after [docker run] if you want the docker container to run in the background.

## Configuration
In most cases, Beatbump requires no special configuration and should just work.\
Beat contains measures to overcome Youtube blocking attempts, and will generate a valid session (inspired by [youtube-trusted-session-generator](https://github.com/iv-org/youtube-trusted-session-generator)) that should pass Youtube checks and allow you to listen ad free.\
This is done by simulating Youtube session via Chromium.

However, If you do encounter errors, where songs do not play, please continue to read and follow one of the options below.

## What to do if songs are not playing

First, ensure you are on the latest Beatbump.\
If songs still do not play, you will need to setup an authenticated session via one of the 2 options below:

### Option 1 - oauth authentication
- Follow the instructions [here](https://developers.google.com/youtube/registering_an_application) to register application.
  For your new credentials, select OAuth client ID and pick TVs and Limited Input devices.
- Obtain the client id and client secret and paste in Beatbump settings
- Click the "Start Oauth flow" and follow the steps in the new tab
- Do not use your main Google account, but create a dedicate one for this purpose.
- Once complete, go back to Beatbump and click on the complete button.
- If all went well, a new Cookie will be saved with your Oauth access token.
- Try to play some music and see if it works now!

### Option 2 - cookie authentication
To run authenticated requests, set it up by first copying your request headers from an authenticated POST request in your browser.
To do so, follow these steps:

- Open a new tab in your favorite browser
- Open the developer tools (Ctrl-Shift-I) and select the "Network" tab
- Go to https://music.youtube.com and ensure you are logged in.
- Do not use your main Google account, but create a dedicate one for this purpose.
- Find an authenticated POST request. The simplest way is to filter by ``/browse`` using the search bar of the developer tools.
  If you don't see the request, try scrolling down a bit or clicking on the library button in the top bar.
- Verify that the request looks like this: **Status** 200, **Name** ``browse?...``
- Find the section called 'Request Headers'
  Find the item named 'Cookie' and copy the value. It is VERY important that you copy the exact value. Double check that you do not include any additional spaces or characters at the start/end of the value Cookie value
- Some browser will have an option to copy the value by right clicking and selecting "Copy Value"
- Paste the value into Beatbump Cookie header setting.
- Try to play some music and see if it works now!

Note :Cookies will expire after some time. This means that you will have to run this process again if Beatbump stops working.


## Project Inspirations

- [Invidious](https://github.com/iv-org/invidious) - a privacy focused alternative YouTube front end.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) -  A feature-rich command-line audio/video downloader 
