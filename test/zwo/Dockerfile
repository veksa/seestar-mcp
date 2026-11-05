# The Seestar's built-in Alpaca server, run off the telescope for tests.
#
# The server is a .NET 8 program; the official ASP.NET runtime image runs its assemblies on any
# architecture. Node is added for the fake firmware it talks to over 127.0.0.1:4700.
FROM node:24-bookworm-slim AS node
FROM mcr.microsoft.com/dotnet/aspnet:8.0
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY entrypoint.sh firmware.mjs settings.mjs /stand/
COPY bin/cat /stand/bin/cat
RUN chmod +x /stand/entrypoint.sh /stand/bin/cat
ENV PATH=/stand/bin:$PATH
EXPOSE 32323
ENTRYPOINT ["/stand/entrypoint.sh"]
