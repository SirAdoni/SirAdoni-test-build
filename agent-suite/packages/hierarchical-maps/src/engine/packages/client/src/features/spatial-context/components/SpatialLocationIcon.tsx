import { cn } from "../package-utils";
import { LocationVector, vectorIdForName } from "./LocationVectorChoices";
import {
  Bath,
  BedDouble,
  BookOpen,
  Castle,
  Church,
  DoorOpen,
  Fence,
  House,
  Landmark,
  MapPin,
  Mountain,
  Store,
  Swords,
  Trees,
  Utensils,
  Warehouse,
  Waves,
} from "lucide-react";
import { SPATIAL_LOCATION_ICON_MAX_LENGTH } from "../../../../../maps-shared/src/maps-model";

interface SpatialLocationIconProps {
  icon?: string | null;
  fallback?: string;
  className?: string;
  name?: string;
  kind?: string;
}

export function SpatialLocationIcon({ icon, name, kind, fallback = "⌖", className }: SpatialLocationIconProps) {
  if (icon?.startsWith("v:"))
    return (
      <LocationVector
        icon={icon}
        className={cn("inline-flex shrink-0 items-center justify-center align-middle", className)}
      />
    );
  if (name && !icon?.startsWith("emoji:")) {
    const label = name.toLowerCase();
    const symbol = /\b(manor|mansion|chateau)\b/.test(label)
      ? "manor"
      : /\btower\b/.test(label)
        ? "tower"
        : /\b(gardens?|greenhouse|orchard)\b/.test(label)
          ? "garden"
          : null;
    const Icon = /\b(training|sparring|armoury|armory|barracks)\b/.test(label)
      ? Swords
      : /\b(gatehouse|gates?)\b/.test(label)
        ? Fence
        : /\b(bedroom|chambers|bedchamber)\b/.test(label)
          ? BedDouble
          : /\b(dining|kitchen|tavern|restaurant)\b/.test(label)
            ? Utensils
            : /\b(library|study|archives?)\b/.test(label)
              ? BookOpen
              : /\b(bath|bathroom|baths)\b/.test(label)
                ? Bath
                : /\b(chapel|temple|church|shrine)\b/.test(label)
                  ? Church
                  : /\b(milkwell|dairy|creamery|warehouse|barn)\b/.test(label)
                    ? Warehouse
                    : /\b(shop|market|stores?|meadowsweet)\b/.test(label)
                      ? Store
                      : /\b(manor|palace|hall)\b/.test(label)
                        ? Landmark
                        : /\b(castle|estate|fortress|keep)\b/.test(label)
                          ? Castle
                          : /\b(forest|woods|grove)\b/.test(label)
                            ? Trees
                            : /\b(lake|river|coast|harbor|harbour)\b/.test(label)
                              ? Waves
                              : /\b(mountain|cave|caldera)\b/.test(label)
                                ? Mountain
                                : /\b(vault|cellar|dungeon)\b/.test(label)
                                  ? DoorOpen
                                  : /\b(house|cottage|nursery|lodge)\b/.test(label)
                                    ? House
                                    : MapPin;
    if (Icon === MapPin && !symbol) {
      const legacy: Record<string, string> = {
        "🗺️": "map",
        "👑": "crown",
        "🏰": "castle",
        "🛡️": "shield",
        "🏠": "house",
        "🏘️": "houses",
        "🌍": "globe",
        "🏛️": "landmark",
        "🚪": "door-open",
        "🧀": "warehouse",
        "🌳": "trees",
      };
      const kinds: Record<string, string> = {
        region: "map",
        settlement: "castle",
        place: "signpost",
        building: "house",
        floor: "layers",
        room: "door-open",
      };
      const vector = vectorIdForName(legacy[icon ?? ""] ?? kinds[kind ?? ""] ?? "map-pin");
      if (vector) return <LocationVector icon={vector} className={className} />;
    }
    return (
      <span
        data-marinara-location-icon
        data-location-symbol={symbol ?? Icon.displayName ?? "place"}
        aria-hidden="true"
        className={cn("inline-flex shrink-0 items-center justify-center align-middle", className)}
      >
        {symbol ? (
          <svg
            viewBox="0 0 24 24"
            width="1em"
            height="1em"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {symbol === "manor" ? (
              <path d="M2 21h20M3 21V11h5V7l4-4 4 4v4h5v10M2 11l3-4 3 4m8 0 3-4 3 4M10 21v-6h4v6M5 14h1m-1 3h1m12-3h1m-1 3h1M11 9h2" />
            ) : symbol === "tower" ? (
              <>
                <path d="M7 21V9L5 7V3h3v2h3V3h2v2h3V3h3v4l-2 2v12M5 21h14M10 21v-5a2 2 0 0 1 4 0v5M11 10h2v3h-2z" />
              </>
            ) : (
              <>
                <path d="M3 21h18M3 14h7v5H3zM14 14h7v5h-7zM12 21v-8M6 14V9m12 5V9M6 11C1 10 2 6 6 8c-3-5 3-6 2-1 5-2 5 4-2 4M18 11c-5-1-4-5 0-3-3-5 3-6 2-1 5-2 5 4-2 4" />
              </>
            )}
          </svg>
        ) : (
          <Icon size="1em" strokeWidth={1.7} />
        )}
      </span>
    );
  }
  const value = icon?.replace(/^emoji:/, "").trim() || fallback;

  return (
    <span
      data-marinara-location-icon
      aria-hidden="true"
      title={value.length > SPATIAL_LOCATION_ICON_MAX_LENGTH ? value : undefined}
      className={cn(
        "inline-block max-w-[2.5em] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-center align-middle",
        className,
      )}
    >
      {value}
    </span>
  );
}
