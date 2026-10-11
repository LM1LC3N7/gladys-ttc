# TTC Toronto

Les **prochains passages** du TTC (autobus, tramways, métro, SLR), l'**état
des lignes de métro et de SLR** et les **vélos Bike Share Toronto** près de
chez vous, dans Gladys.

Cette intégration n'est pas affiliée au TTC, à la Ville de Toronto ni à Bike
Share Toronto.

## Démarrer en 3 étapes

Aucune connaissance technique n'est nécessaire, et aucun compte : il n'y a
**rien à créer, aucune clé**.

1. **Vérifiez l'adresse de votre maison dans Gladys** : _Paramètres →
   Maisons_. La maison doit avoir une position sur la carte. L'intégration s'en
   sert pour trouver les arrêts proches de chez vous. La position reste dans
   votre Gladys.
2. **Installez l'intégration** depuis le catalogue des intégrations, et
   acceptez l'accès à la position de la maison. Ouvrez sa page de
   configuration et cliquez sur **Enregistrer**, sans rien remplir.
3. Ouvrez l'onglet **Découverte** de l'intégration. Les 3 arrêts et les 2
   stations Bike Share les plus proches de chez vous y sont proposés, avec
   leur nom et la direction des lignes, par exemple « TTC – Union Station (509
   → Exhibition) », ainsi que l'appareil **TTC – Métro et SLR**. Cliquez sur
   **Ajouter** pour chacun de ceux qui vous intéressent.

C'est tout. Vous avez maintenant les **prochains passages** de chaque arrêt,
l'état des lignes, et les vélos et places libres de chaque station Bike Share.

Le message en haut de la page de configuration indique toujours la prochaine
chose à faire. Par exemple : « Prêt : 3 arrêts, 2 stations Bike Share Toronto
et les lignes à ajouter. Ouvrez l'onglet Découverte… ».

Les noms des appareils commencent par **TTC –** ou **Bike Share –**, pour les
reconnaître d'un coup d'œil dans la liste des appareils de Gladys. Vous pouvez
les renommer librement dans Gladys.

### Afficher les passages sur le tableau de bord

1. Ouvrez le tableau de bord, puis cliquez sur **Modifier**.
2. Ajoutez un widget et choisissez **Passages TTC**.
3. Choisissez l'arrêt, puis enregistrez.

Les widgets **État des lignes TTC** et **Station Bike Share** s'ajoutent de
la même façon.

Les passages suivis en temps réel sont en vert. Les horaires prévus sont en
gris et marqués d'un **~** : « ~12 min » signifie « prévu dans 12 minutes ».

## D'où viennent les passages

- **Autobus et tramways** : les prédictions en temps réel du TTC, les mêmes
  que sur les panneaux d'arrêt et dans les applications du TTC, lues chaque
  minute.
- **Métro et SLR** (lignes 1, 2, 4, 5 et 6) : le TTC ne publie pas de
  prédiction pour eux. Leurs quais affichent les **horaires prévus**, par
  Transitous, un service communautaire gratuit, lus toutes les 2 minutes. Un
  quai de métro est un arrêt à part entière, un par direction : « Union
  Station - Northbound Platform Towards Finch ».

## Surveiller d'autres arrêts (travail, école…)

Pour un arrêt loin de chez vous :

1. En bas de la page de configuration, cliquez sur **Chercher un arrêt**.
   Tapez un nom de rue, de station ou le numéro de l'arrêt, par exemple
   « Union Station » ou « Bay Front ».
2. La réponse liste les arrêts avec leur numéro et la direction de leurs
   lignes, par exemple `247 — Bay St at Front St West - Union Station (114 →
Union Station, 202 → Union Station via Distillery)`.
3. Copiez le numéro (`247`) dans **Arrêts**, enregistrez, puis ajoutez
   l'arrêt dans l'onglet **Découverte**.

Le numéro est celui inscrit sur chaque panneau d'arrêt du TTC (celui qu'on
envoie par texto au 898882).

Pour les stations Bike Share, le bouton **Chercher une station Bike Share**
fonctionne de la même façon.

### Pour aller plus loin

Le champ **Arrêts** accepte plusieurs numéros séparés par des virgules, un
filtre de lignes après `@` et un nom après `:`.

| Saisie                      | Signification                                      |
| --------------------------- | -------------------------------------------------- |
| `247`                       | toutes les lignes qui passent à l'arrêt 247        |
| `10935@509`                 | seulement la ligne 509                             |
| `10935@509\|510`            | les lignes 509 et 510                              |
| `10935@509:Tram du travail` | ligne 509, affiché sous le nom « Tram du travail » |
| `13816`                     | la ligne 1 à Union Station, direction Finch        |

## Ce que contient chaque appareil

**Arrêt :**

- **Prochain passage**, **Passage 2**… : les minutes d'attente. 999 signifie
  qu'aucun passage n'est annoncé.
- **Ligne du prochain passage**… : le numéro de ligne (« 504 », « 96 »).
- **Prochains passages** : un résumé, par exemple `504 3 min · 504 11 min`.

**Métro et SLR :** pour chaque ligne, un **état** (`Normal`, `Perturbé`,
`Avis` ou `Inconnu`) et le **message** de l'alerte du TTC. Une fermeture ou un
retard important est une perturbation ; une zone de ralentissement permanente
(« trains will move slower than usual ») ou l'annonce d'une fermeture à venir
est un avis. Les ascenseurs et escaliers mécaniques ne changent pas l'état
d'une ligne. Les messages du TTC sont en anglais.

**Station Bike Share :** les vélos (électriques compris), les vélos
électriques, les points d'ancrage libres et l'état de la station.

Une station qui disparaît du réseau affiche 0 vélo, 0 place et l'état
« Retirée du réseau Bike Share Toronto (saisonnier ?) », avec un point orange
sur l'appareil. Elle reprend seule à son retour.

## Scènes

**Déclencheurs :**

- **Passage imminent** : un passage a lieu dans moins de 1, 2, 3, 5, 10 ou 15
  minutes. Exemple : « quand le 504 est à 5 minutes, allumer la lampe de
  l'entrée ».
- **État d'une ligne modifié** : une ligne est perturbée, revient à la
  normale ou reçoit un avis. Exemple : « si la ligne 1 est perturbée,
  m'envoyer un message ».
- **Station Bike Share modifiée** : la station n'a plus de vélos ou de
  places, ou en retrouve.

**Actions :**

- **Lire les prochains passages** : par exemple, un message chaque matin
  « Ton 504 passe dans {{minutes}} minutes ».
- **Lire l'état d'une ligne** : renvoie l'état, le message du TTC et `normal`
  (vrai ou faux).

## Dépannage

| Message ou symptôme                                    | Que faire                                                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| « indiquez l'adresse de votre maison »                 | _Paramètres → Maisons_ : placez la maison sur la carte, puis enregistrez à nouveau la configuration de l'intégration. |
| « Gladys n'a pas partagé la position de votre maison » | Réinstallez l'intégration et acceptez l'accès à la position, ou tapez des numéros d'arrêt.                            |
| Rien dans l'onglet Découverte                          | Lisez le message de la page de configuration : il dit ce qui manque.                                                  |
| « L'arrêt … n'est pas dans la liste des arrêts »       | Vérifiez le numéro sur le panneau. Un arrêt tout nouveau arrive avec la prochaine version de l'intégration.           |
| Station « Retirée du réseau Bike Share »               | La station n'est plus dans le réseau : elle reviendra seule.                                                          |
| Un arrêt reste à 999                                   | Aucun passage annoncé (la nuit), ou un filtre de ligne qui ne correspond à aucune ligne de l'arrêt.                   |
| Un quai de métro affiche des « ~ »                     | Normal : le TTC ne publie pas de temps réel pour le métro, ce sont les horaires prévus.                               |

## Vie privée, données et licences

- La position de la maison ne sert qu'à chercher les arrêts proches, dans la
  liste des arrêts livrée avec l'intégration : elle n'est envoyée nulle part.
- Liste des arrêts : TTC Routes and Schedules, données ouvertes de la Ville
  de Toronto, sous la
  [Open Government Licence – Toronto](https://open.toronto.ca/open-data-license/)
  (mise à jour à chaque version).
- Temps réel et alertes : données du TTC, © Toronto Transit Commission.
- Horaires du métro et du SLR : [Transitous](https://transitous.org/sources/),
  un service communautaire gratuit, à partir des données du TTC.
- Vélos : flux GBFS public de Bike Share Toronto.
- Code de l'intégration : licence Apache 2.0.
