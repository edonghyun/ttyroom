FROM eclipse-temurin:21-jdk-jammy
RUN groupadd --gid 10001 benchmark && useradd --uid 10001 --gid benchmark benchmark \
    && mkdir /data && chown benchmark:benchmark /data
COPY ttyroom-backend.jar /app/server.jar
USER 10001:10001
ENTRYPOINT ["java", "-Xms256m", "-Xmx512m", "-XX:+UseG1GC", "-jar", "/app/server.jar"]
