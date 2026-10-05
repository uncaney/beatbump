# Playwright + Google Chrome (proprietary codecs: AAC/H.264). The stock Chromium cannot decode the
# AAC m4a served by iv-vp (/aud) nor googlevideo itag 140, so playback assertions need real Chrome.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy
RUN npx -y playwright@1.47.0 install chrome
