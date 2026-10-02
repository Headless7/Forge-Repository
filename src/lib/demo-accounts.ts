/** Seeded demo accounts (development only — shown on the sign-in page when DEMO_MODE=true). */
export const DEMO_PASSWORD = "demo1234";

export const DEMO_ACCOUNTS = [
  { email: "giorgos@nightfall.gg", name: "Giorgos Petrou", username: "giorgos", role: "OWNER", title: "Studio Lead", hint: "Owner · reviews work" },
  { email: "lena@nightfall.gg", name: "Lena Fischer", username: "lena", role: "MANAGER", title: "Producer", hint: "Manager · reviews work" },
  { email: "james@nightfall.gg", name: "James Walker", username: "james", role: "MEMBER", title: "VFX Artist", hint: "Member · VFX artist" },
  { email: "alex@nightfall.gg", name: "Alex Kim", username: "alex", role: "MEMBER", title: "Animator", hint: "Member · animator" },
  { email: "sofia@nightfall.gg", name: "Sofia Reyes", username: "sofia", role: "MEMBER", title: "UI Designer", hint: "Member · UI designer" },
  { email: "mike@nightfall.gg", name: "Mike Novak", username: "mike", role: "MEMBER", title: "3D Modeler", hint: "Member · models & maps" },
  { email: "kenji@nightfall.gg", name: "Kenji Sato", username: "kenji", role: "MEMBER", title: "Gameplay Programmer", hint: "Member · scripting" },
  { email: "ruby@nightfall.gg", name: "Ruby Chen", username: "ruby", role: "VIEWER", title: "Community Manager", hint: "Viewer · read-only" },
  { email: "omar@emberlight.dev", name: "Omar Haddad", username: "omar", role: "OWNER", title: "Founder", hint: "Other studio (Emberlight)" },
] as const;
