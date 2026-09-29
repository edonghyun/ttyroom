package dev.ttyroom.application;

/** Transient workspace pointer position; never stored in a participant snapshot. */
public record CursorPosition(double x, double y) {}
