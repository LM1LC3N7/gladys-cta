# Chicago Transit Departures

Les **prochains trains du 'L'** à quatre stations au plus, les **prochains
bus** à quatre arrêts au plus, et les **alertes de service** en cours, dans
Gladys. Données fournies par la CTA.

Cette intégration n'est pas officielle : elle n'est ni liée à la Chicago
Transit Authority, ni approuvée ni parrainée par elle, et ce n'est pas une
source officielle. Vérifiez sur transitchicago.com ou aux panneaux des
stations avant de partir. Elle n'a **jamais été testée avec une vraie clé** ni
sur une vraie installation de Gladys par son auteur : Train Tracker et Bus
Tracker ont été simulés d'après leur documentation officielle ; l'API Customer
Alerts (sans clé) a été lue en vrai.

## Pour commencer

1. **Demandez les clés gratuites** dont vous avez besoin sur le
   [CTA Developer Center](https://www.transitchicago.com/developers/) :
   - trains : le [formulaire de clé Train Tracker](https://www.transitchicago.com/developers/traintrackerapply/)
     (réponse par e-mail) ;
   - bus : créez un compte sur [ctabustracker.com](https://www.ctabustracker.com/)
     et demandez-y la clé de l'API Bus Tracker (réponse par e-mail).

   Les alertes ne demandent pas de clé. Seule la clé de ce que vous suivez est
   nécessaire.

2. **Trouvez les identifiants.** Une station de train est un nombre de 40000 à
   49999 (ex. 40380 pour Clark/Lake : tous les quais) ; un quai, de 30000 à
   39999, ne garde qu'une direction. Ils sont dans la liste « CTA – System
   Information – List of 'L' Stops » du portail de données de la ville de
   Chicago. L'identifiant d'un arrêt de bus est affiché sur son panneau et sur
   ctabustracker.com (ex. 456).
3. **Installez l'intégration**, saisissez les clés et les identifiants dans sa
   configuration, et enregistrez. Ouvrez l'onglet **Découverte** et appuyez sur
   **Ajouter** pour chaque station ou arrêt. Son nom devient celui de la CTA
   (« Clark/Lake (trains du 'L') ») après la première lecture, sauf si vous en
   avez saisi un.

**Un appareil par station ou arrêt.** Un appareil appartient à un
emplacement et à son identifiant : si vous saisissez un autre identifiant
dans un emplacement, l'intégration propose un nouvel appareil ; l'ancien n'est
plus mis à jour et garde ses dernières valeurs (la page de configuration le
nomme sous « Plus mis à jour » : supprimez-le dans Gladys). Changer le filtre
de lignes garde l'appareil.

## Ce que montre chaque appareil

| Fonction                | Type     | Contenu                                                                                                                                                |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prochain départ         | texte    | « Green Line → Harlem/Lake dans 4 min (05:18) », « à l'approche », « en retard » et « horaire théorique » (pas de suivi en direct) quand la CTA le dit |
| Départ suivant          | texte    | la même chose pour le suivant                                                                                                                          |
| Départs prévus (30 min) | compteur | pour les scènes, ex. « plus de 0 »                                                                                                                     |
| Départs                 | texte    | « 05:14 · Green Line → Harlem/Lake 4, 9 min · Brown Line → Kimball 11 min »                                                                            |
| Alertes en cours        | compteur | alertes de la station (ou des lignes de bus vues à l'arrêt)                                                                                            |
| Alerte                  | texte    | la première alerte (majeure d'abord, puis la plus grave) et combien d'autres                                                                           |

Les heures sont celles de Chicago. Chaque lecture publie toutes les valeurs :
un départ disparu devient « Aucun départ suivant (lu à 05:15) », jamais un
nombre laissé derrière. Une lecture en échec, périmée ou illisible ne publie
**rien** (pas de 0) : la page de configuration dit pourquoi et depuis quand.
Les courses de bus annulées, invalidées ou sans montée ne sont pas des départs
(types dynamiques 1, 4, 12, 16, 17 et 18 de Bus Tracker ; pour le 12, la CTA
ne veut pas que l'annulation soit montrée : le bus est simplement écarté).

Les alertes d'un arrêt de bus sont celles des lignes vues à l'arrêt par Bus
Tracker (l'API Customer Alerts ne connaît pas les arrêts de bus). Celles d'une
station sont celles de la station et de ses lignes. Pour une station, la CTA
envoie aussi les alertes d'ascenseur et d'accessibilité de toutes les autres
stations de ses lignes : elles sont écartées (impact « Elevator Status » ou
gravité 1-19, nommant une autre station, non majeures). Une fermeture d'une
autre station ou une alerte majeure sur une ligne suivie est gardée. Sans clé, les alertes d'une station
(40000-49999) sont lues quand même ; celles d'un quai (30000-39999) et d'un
arrêt de bus attendent une première lecture de leurs départs.

Le déclencheur de scène **Nouvelle alerte CTA à une station ou un arrêt** part
une fois pour une alerte vue pour la première fois à une station ou un arrêt
suivi, si elle a commencé dans les dernières 24 heures (la première lecture
apprend seulement les alertes déjà là). Vous pouvez ne garder que les alertes
majeures, ou les autres.

## Requêtes et quotas

- Une requête Train Tracker par station et par lecture, une requête Bus
  Tracker pour tous les arrêts de bus par lecture ; les alertes toutes les
  5 minutes (à chaque lecture quand l'intervalle est plus long), une requête
  par station ou arrêt. Une requête à la fois, à 1 s
  d'écart au moins.
- La CTA accorde à chaque clé **100 000 requêtes par jour** par défaut
  (documentation lue le 2026-11-27). L'intégration tient son propre **budget
  quotidien par clé** (10 000 par défaut, réglage « Budget quotidien par
  clé ») : elle compte les requêtes du jour de Chicago, écrit le compte dans
  `/data` avant chaque requête (un redémarrage le garde), et allonge
  l'intervalle de lecture quand les lectures prévues ne tiendraient pas dans
  90 % du budget (le statut dit « Lectures toutes les N s »). Budget épuisé :
  cette clé attend le jour suivant de Chicago.
- Si la CTA dit que la limite quotidienne est atteinte, cette clé se met en
  pause jusqu'à 00 h 05 à Chicago (une heure au moins). Un 429, une erreur
  serveur ou une réponse inattendue mettent ce service en pause de 1 ou
  2 minutes, doublées jusqu'à 6 heures ; les autres services continuent.
- Si la CTA **refuse une clé**, plus rien n'est envoyé avec elle, même après un
  redémarrage, tant que vous ne saisissez pas une autre clé ou n'appuyez pas
  sur **Voir la dernière lecture / réessayer la clé**, qui envoie une requête
  avec elle (30 s au moins après la précédente). Un succès lève le refus. Un
  HTTP 401 ou 403 n'est pas pris pour un refus : seule la réponse « clé
  invalide » de la CTA l'est.
- Un redémarrage, une reconnexion, une configuration enregistrée sans
  changement et la Découverte ne lisent pas plus tôt que l'intervalle. Le
  bouton ne lit que pour réessayer une clé refusée, comme dit plus haut.

## Vos clés

Les clés sont gardées par Gladys dans sa base, jamais réaffichées, et envoyées
seulement à la CTA (dans l'adresse de chaque requête, comme la CTA l'exige).
L'intégration ne les écrit ni dans ses journaux, ni dans son statut, ni dans
`/data` : elle y garde une empreinte salée de 8 bits d'une clé refusée
(256 valeurs possibles, partagées par d'innombrables clés), assez pour savoir
« une autre clé » après un redémarrage.

## Dépannage

Le message en haut de la page de configuration dit où en est chaque station et
chaque arrêt, et combien de requêtes chaque clé a utilisé aujourd'hui.
Messages courants :

- « La CTA ne connaît pas cet identifiant » : vérifiez-le ; redemandé après
  30 minutes.
- « Aucun bus n'a encore confirmé cet identifiant d'arrêt » : l'arrêt n'a pas
  de prévision maintenant et aucun bus n'y a encore été vu ; rien n'est publié
  avant.
- « Diffère de l'horloge de cette machine » : réglez l'horloge de la machine
  qui fait tourner Gladys.

## Conditions d'utilisation

Les données sont utilisées selon le
[CTA Developer License Agreement and Terms of Use](https://www.transitchicago.com/developers/terms/)
et les CTA Trademark Guidelines for Developers : révocable, sans garantie,
sans logo de la CTA. Données fournies par la CTA. Chaque utilisateur lit les
API avec ses propres clés depuis son propre Gladys.
