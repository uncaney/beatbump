# syntax=docker/dockerfile:1
# Use a multi-stage build for better image size
FROM node:22.3.0 as frontend-builder

WORKDIR /app

ARG PORT
ENV PORT ${PORT}

ARG ALLOW_IFRAME
ENV ALLOW_IFRAME ${ALLOW_IFRAME}
ARG PUBLIC_ALLOW_THUMBNAIL_PROXY
ENV PUBLIC_ALLOW_THUMBNAIL_PROXY ${PUBLIC_ALLOW_THUMBNAIL_PROXY}
ARG SERVER_DOMAIN
ENV SERVER_DOMAIN ${SERVER_DOMAIN}

# install dependencies
COPY /app/package.json /app/package-lock.json ./

RUN npm ci --legacy-peer-deps

# copy local files to image
COPY /app .

RUN npm exec svelte-kit sync
RUN npm run build

FROM golang:1.21.0 as build

# Set destination for COPY
WORKDIR /app

# Download Go modules
COPY go.mod go.sum ./
RUN go mod download

# Copy the source code. Note the slash at the end, as explained in
# https://docs.docker.com/engine/reference/builder/#copy
COPY backend /app/backend
COPY *.go ./

# Build
RUN CGO_ENABLED=0 GOOS=linux go build -o /beat-server

FROM chromedp/headless-shell:latest

RUN apt-get update && apt install ca-certificates -y


WORKDIR /app

COPY --from=build /beat-server /app/beat-server
COPY --from=frontend-builder /app/build /app/build

# Optional:
# To bind to a TCP port, runtime parameters must be supplied to the docker command.
# But we can document in the Dockerfile what ports
# the application is going to listen on by default.
# https://docs.docker.com/engine/reference/builder/#expose
EXPOSE 8080

# Run
ENTRYPOINT ["/app/beat-server"]