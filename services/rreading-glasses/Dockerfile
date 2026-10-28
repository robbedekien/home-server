# Upstream rreading-glasses (Hardcover) with the batch size capped at 5.
# Hardcover rejects >5 top-level fields per request, so upstream's batch of 25 breaks
# author bibliographies (blampe/rreading-glasses#574, #595; fix PR #575 never merged).
# ponytail: pinned patch; drop this build and go back to blampe/rreading-glasses:hardcover once upstream fixes it.
FROM golang:1.26-alpine AS build
ARG RG_COMMIT=a2939b625d91389d3f0a3e58cbc3bfa7ebb8390a
RUN apk add --no-cache git \
 && git clone https://github.com/blampe/rreading-glasses /src \
 && git -C /src checkout "$RG_COMMIT"
WORKDIR /src
RUN sed -i 's|time.Second, 25 /\* Not sure about this \*/|2*time.Second, 5|' cmd/rghc/main.go \
 && grep -q '2\*time.Second, 5,' cmd/rghc/main.go \
 && CGO_ENABLED=0 go build -o /main -ldflags="-w -s" ./cmd/rghc

FROM gcr.io/distroless/static:nonroot
COPY --from=build /main /main
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
EXPOSE 8788
