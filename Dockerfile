FROM personal-whatsapp-mcp:trial
USER root
WORKDIR /app/amalia-events
COPY --chown=node:node . ./
USER node
CMD ["node", "server.mjs"]
