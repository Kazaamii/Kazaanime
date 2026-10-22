$(document).ready(function () {
    $(".btn-user-avatar").click(function (e) {
        e.preventDefault();
        e.stopPropagation();
        $(this).parent().find(".dropdown-menu").toggleClass("show");
    });

    $(document).click(function (e) {
        if (!$(e.target).closest(".dropdown").length) {
            $(".dropdown-menu").removeClass("show");
        }
    });


    new Swiper("#slider", {
        navigation: {
            nextEl: ".swiper-button-next",
            prevEl: ".swiper-button-prev",
        },
        pagination: {
            el: "#slider .swiper-pagination",
            clickable: true,
        },
        loop: true,
        autoplay: {
            delay: 3000,
        },
    });
    new Swiper("#trending-home .swiper-container", {
        slidesPerView: 6,
        spaceBetween: 30,
        navigation: {
            nextEl: ".trending-navi .navi-next",
            prevEl: ".trending-navi .navi-prev",
        },
        breakpoints: {
            320: {
                slidesPerView: 3,
                spaceBetween: 2,
            },
            480: {
                slidesPerView: 3,
                spaceBetween: 15,
            },
            900: {
                slidesPerView: 4,
                spaceBetween: 20,
            },
            1320: {
                slidesPerView: 6,
                spaceBetween: 20,
            },
            1880: {
                slidesPerView: 8,
                spaceBetween: 20,
            },
        },
        autoplay: 2000,
    });
    $("#mobile_search").click(function () {
        $("#mobile_search, #search").toggleClass("active");
    });
    $(".cbox-collapse .btn-showmore").click(function (e) {
        $(this).parent().find(".anif-block-ul").toggleClass("no-limit");
        $(this).toggleClass("active");
    });
    $("#text-home-expand").click(function (e) {
        $(".text-home").toggleClass("thm-expand");
    });
    $('[data-toggle="tooltip"]').tooltip();
    $(".toggle-basic").click(function (e) {
        $(this).toggleClass("off");
    });
    $(".f-genre-item").click(function () {
        $(this).toggleClass("active");
        var genreIds = [];
        $(".f-genre-item").each(function () {
            $(this).hasClass("active") && genreIds.push($(this).data("id"));
        });
        $("#f-genre-ids").val(genreIds.join(","));
    });
    if ($(".film-description .text").length > 0) {
        var fullDes = $(".film-description .text").html().trim();
        if (fullDes.length > 300) {
            var desShow = fullDes.substring(0, 300) + '...<span class="btn-more-desc more"><i class="fas fa-plus"></i> More</span>';
            $(".film-description .text").html(desShow);

            $(document).on("click", ".btn-more-desc", function () {
                $(".film-description .text").toggleClass("text-full");
                $(this).toggleClass("active");

                if ($(this).hasClass("more")) {
                    $(".film-description .text").html(
                        fullDes + '<span class="btn-more-desc less"><i class="fas fa-minus"></i> Less</span>'
                    );
                } else {
                    $(".film-description .text").html(desShow);
                }
            });
        }
    }
    $(window).scroll(function () {
        const scrollTop = $(window).scrollTop();
        const $fixedElement = $('.header');

        if (scrollTop >= 10) {
            $fixedElement.addClass("fixed");
        } else {
            $fixedElement.removeClass("fixed");
        }

        if (scrollTop >= 100) {
            $("#totop").addClass("active");
        } else {
            $("#totop").removeClass("active");
        }
    });

    $("#totop").click(function (event) {
        event.preventDefault();
        $("html, body").animate({
            scrollTop: 0
        }, "slow");
    });

    if (typeof $.fn.qtip !== "undefined") {


        $(".item-qtip").qtip({
            prerender: true,
            content: {
                text: function (event, api) {
                    const target = api.elements.target;

                    if (!target.hasClass("loaded")) {
                        target.addClass("loaded");

                        const animeId = target.attr("data-id");

                        if (!animeId || isNaN(animeId) || animeId <= 0) {
                            api.set("content.text", '<div class="qtip-error">Invalid anime ID</div>');
                            return;
                        }

                        $.ajax({
                            url: hianime_ajax.rest_url + 'anime/qtip?animeId=' + animeId,
                            type: "GET",
                            success: function (data, status) {
                                if (data && data.html) {
                                    api.set("content.text", data.html);
                                } else {
                                    api.set("content.text", '<div class="qtip-error">No content available</div>');
                                }
                            },
                            error: function (xhr, status, error) {
                                console.error('Qtip AJAX error:', error);
                                api.set("content.text", '<div class="qtip-error">Failed to load content</div>');
                            }
                        });
                    }

                    return `
                <div class="loading-relative">
                    <div class="loading">
                        <div class="span1"></div>
                        <div class="span2"></div>
                        <div class="span3"></div>
                    </div>
                </div>
            `;
                }
            },
            show: {
                solo: true,
                effect: function (offset) {
                    $(this).fadeIn(100);
                }
            },
            hide: {
                fixed: true,
                effect: function (offset) {
                    $(this).fadeOut(100);
                }
            },
            position: {
                at: 'center',
                viewport: $(window),
                effect: false
            },
            style: {
                width: 300,
                tip: {
                    corner: false
                }
            }
        });
    }

    $(".genre-toggle").click(function () {
        var $genreMenu = $("#sidebar_subs_genre");
        var $genreIcon = $(".genre-icon");

        var isVisible = $genreMenu.css("display") === "block";
        $genreMenu.css("display", isVisible ? "none" : "block");
        $genreIcon.toggleClass("fa-angle-down", isVisible);
        $genreIcon.toggleClass("fa-angle-up", !isVisible);
    });

    waitForToggleLang(function (toggleBtns) {
        var animePref = getUserSetting("anime_name", "en");

        function updateAnimeNames(mode) {
            $(".dynamic-name").each(function () {
                var $item = $(this);
                var jpName = $item.attr("data-jname");
                var enName = $item.attr("data-en") || $item.text().trim();

                if (!$item.attr("data-en")) {
                    $item.attr("data-en", enName);
                }

                $item.text(mode === "en" ? enName : jpName);
            });

            $(toggleBtns).each(function () {
                var $btn = $(this);
                if (mode === "jp") {
                    $btn.addClass("off");
                } else {
                    $btn.removeClass("off");
                }
            });
        }

        updateAnimeNames(animePref);

        $(toggleBtns).each(function () {
            $(this).click(function () {
                animePref = animePref === "en" ? "jp" : "en";
                updateLocalStorageSetting("anime_name", animePref);
                updateAnimeNames(animePref);
            });
        });
    });

    function waitForToggleLang(callback) {
        var checkExist = setInterval(function () {
            var toggleBtns = $(".toggle-lang").get();
            if (toggleBtns.length > 0) {
                clearInterval(checkExist);
                callback(toggleBtns);
            }
        }, 50);
    }


    function performSearchSuggestions(keyword) {
        $.ajax({
            url: user.rest_url + 'search/suggestions',
            type: "GET",
            data: {
                keyword: keyword
            },
            beforeSend: function () {
                $("#search-suggest").show();
                $("#search-loading").show();
                $("#search-suggest .result").empty();
            },
            success: function (response) {
                $("#search-loading").hide();

                if (response && response.html) {
                    $("#search-suggest .result").html(response.html);
                    $("#search-suggest").show();

                    $("#search-suggest .result").slideDown("fast");
                } else {
                    $("#search-suggest .result").html('<div class="no-results">No suggestions found</div>');
                }
            },
            error: function (xhr, status, error) {
                $("#search-suggest").hide();
                $("#search-loading").hide();
                $("#search-suggest .result").html('<div class="error">Error loading suggestions</div>');
                console.error('Search suggestions error:', error);
            }
        });
    }

    let searchTimeout = null;

    $(".search-input").keyup(function (e) {
        let keyCode = e.keyCode || e.which;

        if ([13, 32].indexOf(keyCode) < 0) {

            if (searchTimeout != null) {
                clearTimeout(searchTimeout);
            }

            searchTimeout = setTimeout(function () {
                searchTimeout = null;

                let searchValue = $(".search-input").val().trim();

                if (searchValue.length > 1) {
                    performSearchSuggestions(searchValue);
                } else {
                    $("#search-suggest").hide();
                    $("#search-suggest .result").empty();
                }
            }, 500);
        }
    });
});
$(document).on("click", ".dropdown-menu-right", function (e) {
    e.stopPropagation();
});

function updateOneSetting(key, newValue) {
    if (!window.user || !window.user.is_logged_in) {
        localStorage.setItem(key, newValue);
        return $.Deferred().resolve().promise();
    }

    if (window.user.settings) {
        window.user.settings[key] = newValue;
    }

    if (typeof updateUserSetting === "function") {
        updateUserSetting(key, newValue);
    }

    return $.Deferred().resolve().promise();
}